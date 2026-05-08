"""阿里云 SMS provider — 发送验证码短信。

凭据来源优先级（后者覆盖前者）：
    1. 环境变量 LINTU_SMS_*（dev 模式从终端起 sidecar 时方便）
    2. 应用内配置 config.json 的 sms_* 键（生产模式：用户在 设置→短信服务 里配）

生产打包后 .app 双击启动**不会读 ~/.zshrc / ~/.lintu-secrets.zsh**（macOS GUI
应用环境），所以必须靠 config.json。dev 模式才靠 env。

不可用时（凭据未配 / SDK 未装）自动降级到 stdout，把验证码 print 出来。
开发期 + 阿里云审核期不阻塞业务流程。

config.json 键名：
    sms_provider           固定 "aliyun"（其它 provider 暂不支持）
    sms_access_key         阿里云 RAM 子账号 AccessKey ID
    sms_access_secret      对应的 AccessKey Secret
    sms_sign_name          阿里云控制台申请的"签名"，如 "灵图"
    sms_template_code      模板编号，如 "SMS_xxxxxxxx"，模板内容须含 ${code}
    sms_endpoint           可选 — 直接覆盖 endpoint（如 dysmsapi.aliyuncs.com）
    sms_region             可选 — 默认走全局 dysmsapi.aliyuncs.com

注：默认走 **dysmsapi.aliyuncs.com**（不带 region）— 原因是开发机常见的
ClashX / V2Ray 等 fake-IP 模式 VPN 会把 dysmsapi.cn-hangzhou.aliyuncs.com
解析到本机 198.18.x.x，TLS 握手直接挂掉。全局 endpoint 不在常见 fake-IP
劫持名单里，更稳。需要严格指定地域时再设 sms_region。
"""
from __future__ import annotations

import json
import logging
import os
import secrets
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def _read_config_value(key: str) -> Optional[str]:
    """从 config.json 读一个值。文件不存在 / 读失败 / key 缺失都返回 None。"""
    try:
        from sidecar.config import DATA_DIR
        cfg_path = Path(DATA_DIR) / "config.json"
        if not cfg_path.exists():
            return None
        data = json.loads(cfg_path.read_text())
        v = data.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
        return None
    except Exception as e:
        logger.debug("config.json read failed for %s: %s", key, e)
        return None


def _resolve(env_name: str, config_key: str) -> Optional[str]:
    """凭据查找：env 优先（dev 友好），config.json 兜底（生产 .app 必须靠这个）。"""
    v = os.environ.get(env_name)
    if v and v.strip():
        return v.strip()
    return _read_config_value(config_key)


def _get_credentials() -> dict[str, Optional[str]]:
    return {
        "access_key":    _resolve("LINTU_SMS_ACCESS_KEY",    "sms_access_key"),
        "access_secret": _resolve("LINTU_SMS_ACCESS_SECRET", "sms_access_secret"),
        "sign_name":     _resolve("LINTU_SMS_SIGN_NAME",     "sms_sign_name"),
        "template_code": _resolve("LINTU_SMS_TEMPLATE_CODE", "sms_template_code"),
        "endpoint":      _resolve("LINTU_SMS_ENDPOINT",      "sms_endpoint"),
        "region":        _resolve("LINTU_SMS_REGION",        "sms_region"),
    }


def is_configured() -> bool:
    creds = _get_credentials()
    return all(creds[k] for k in ("access_key", "access_secret", "sign_name", "template_code"))


def generate_code(length: int = 6) -> str:
    """6 位数字（不含 0 开头偏置 — secrets 已经均匀）"""
    return "".join(secrets.choice("0123456789") for _ in range(length))


async def send_code(phone: str, code: str) -> tuple[bool, str | None]:
    """发送验证码。返回 (ok, error_message)。

    凭据未配 / SDK 未装时按 flavor 分流：
      - dev / ops：log 验证码到 stdout 返回 (True, None)，开发联调用
      - user：返回 (False, error)，让前端弹真实错误而不是误以为发出去了

    生产部署必须配齐凭据，否则**任何人**都能在服务日志里看到所有人的验证码。
    """
    is_user_flavor = os.environ.get("LINTU_BUILD_FLAVOR") == "user"

    creds = _get_credentials()
    if not all(creds[k] for k in ("access_key", "access_secret", "sign_name", "template_code")):
        if is_user_flavor:
            logger.error(
                "[sms] 凭据未配齐 — 用户版拒绝降级到 stdout（避免误以为短信已发出）"
            )
            return False, "短信服务未配置，请在 设置→短信服务 里填阿里云凭据"
        logger.warning(
            "[sms] provider unconfigured — DEV FALLBACK: phone=%s code=%s "
            "(在 设置→短信服务 里配凭据后改走真实短信)", phone, code,
        )
        return True, None

    try:
        from alibabacloud_dysmsapi20170525.client import Client as DysmsapiClient
        from alibabacloud_dysmsapi20170525 import models as dysmsapi_models
        from alibabacloud_tea_openapi import models as open_api_models
    except ImportError as e:
        logger.error("[sms] alibabacloud SDK 未装：%s", e)
        if is_user_flavor:
            return False, "短信 SDK 未打包到客户端，请升级到最新版本"
        logger.warning("[sms] DEV FALLBACK: phone=%s code=%s", phone, code)
        return True, None

    # endpoint 优先级：显式 endpoint > region 拼接 > 默认全局（不带 region）
    endpoint = creds["endpoint"]
    if not endpoint:
        region = creds["region"]
        endpoint = f"dysmsapi.{region}.aliyuncs.com" if region else "dysmsapi.aliyuncs.com"

    config = open_api_models.Config(
        access_key_id=creds["access_key"],
        access_key_secret=creds["access_secret"],
        endpoint=endpoint,
    )
    client = DysmsapiClient(config)

    req = dysmsapi_models.SendSmsRequest(
        phone_numbers=phone,
        sign_name=creds["sign_name"],
        template_code=creds["template_code"],
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
