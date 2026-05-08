"""阿里云 SMS provider — 发送验证码短信。

不可用时（未配置凭据 / SDK 未装）会自动降级到 stdout，把验证码 print 出来。
开发期 + 阿里云审核期不阻塞业务流程。

环境变量：
    LINTU_SMS_PROVIDER          固定 "aliyun"（其它 provider 暂不支持）
    LINTU_SMS_ACCESS_KEY        阿里云 RAM 子账号 AccessKey ID
    LINTU_SMS_ACCESS_SECRET     对应的 AccessKey Secret
    LINTU_SMS_SIGN_NAME         阿里云控制台申请的"签名"，如 "灵图"
    LINTU_SMS_TEMPLATE_CODE     模板编号，如 "SMS_xxxxxxxx"
                                模板内容须含 ${code} 占位
    LINTU_SMS_ENDPOINT          可选 — 直接覆盖 endpoint（如 dysmsapi.aliyuncs.com）
    LINTU_SMS_REGION            可选 — 默认走全局 dysmsapi.aliyuncs.com；
                                设了之后用 dysmsapi.{region}.aliyuncs.com

注：默认走 **dysmsapi.aliyuncs.com**（不带 region）— 原因是开发机常见的
ClashX / V2Ray 等 fake-IP 模式 VPN 会把 dysmsapi.cn-hangzhou.aliyuncs.com
解析到本机 198.18.x.x，TLS 握手直接挂掉。全局 endpoint 不在常见 fake-IP
劫持名单里，更稳。需要严格指定地域时再 export LINTU_SMS_REGION。
"""
from __future__ import annotations

import logging
import os
import secrets

logger = logging.getLogger(__name__)


def is_configured() -> bool:
    return all(os.environ.get(k) for k in (
        "LINTU_SMS_ACCESS_KEY",
        "LINTU_SMS_ACCESS_SECRET",
        "LINTU_SMS_SIGN_NAME",
        "LINTU_SMS_TEMPLATE_CODE",
    ))


def generate_code(length: int = 6) -> str:
    """6 位数字（不含 0 开头偏置 — secrets 已经均匀）"""
    return "".join(secrets.choice("0123456789") for _ in range(length))


async def send_code(phone: str, code: str) -> tuple[bool, str | None]:
    """发送验证码。返回 (ok, error_message)。

    未配置凭据时降级：log 验证码到 stdout 返回 (True, None)，便于开发 / 阿里云
    审核期联调。生产部署必须配齐凭据，否则**任何人**都能在服务日志里看到所有
    人的验证码。
    """
    if not is_configured():
        logger.warning(
            "[sms] provider unconfigured — DEV FALLBACK: phone=%s code=%s "
            "(配 LINTU_SMS_* 后改走真实短信)", phone, code,
        )
        return True, None

    try:
        from alibabacloud_dysmsapi20170525.client import Client as DysmsapiClient
        from alibabacloud_dysmsapi20170525 import models as dysmsapi_models
        from alibabacloud_tea_openapi import models as open_api_models
    except ImportError as e:
        logger.error("[sms] alibabacloud SDK 未装：%s — 退回到 stdout", e)
        logger.warning("[sms] DEV FALLBACK: phone=%s code=%s", phone, code)
        return True, None

    # endpoint 优先级：env 覆盖 > REGION 拼接 > 默认全局（不带 region）
    endpoint = os.environ.get("LINTU_SMS_ENDPOINT")
    if not endpoint:
        region = os.environ.get("LINTU_SMS_REGION")
        endpoint = f"dysmsapi.{region}.aliyuncs.com" if region else "dysmsapi.aliyuncs.com"

    config = open_api_models.Config(
        access_key_id=os.environ["LINTU_SMS_ACCESS_KEY"],
        access_key_secret=os.environ["LINTU_SMS_ACCESS_SECRET"],
        endpoint=endpoint,
    )
    client = DysmsapiClient(config)

    req = dysmsapi_models.SendSmsRequest(
        phone_numbers=phone,
        sign_name=os.environ["LINTU_SMS_SIGN_NAME"],
        template_code=os.environ["LINTU_SMS_TEMPLATE_CODE"],
        template_param=f'{{"code":"{code}"}}',
    )

    try:
        # SDK 是同步的；用 to_thread 跑避免阻塞 event loop
        import asyncio
        resp = await asyncio.to_thread(client.send_sms, req)
        body = getattr(resp, "body", None)
        if body and getattr(body, "code", None) == "OK":
            logger.info("[sms] sent to %s (biz_id=%s)", phone, getattr(body, "biz_id", "-"))
            return True, None
        msg = getattr(body, "message", "unknown") if body else "no body"
        logger.warning("[sms] send failed: %s", msg)
        return False, msg
    except Exception as e:
        logger.error("[sms] exception: %s", e)
        return False, str(e)[:200]
