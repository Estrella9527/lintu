"""阿里云 SMS provider — 发送验证码短信。

凭据来源（按 LINTU_SMS_* 环境变量）：
    LINTU_SMS_ACCESS_KEY        阿里云 RAM 子账号 AccessKey ID
    LINTU_SMS_ACCESS_SECRET     对应的 AccessKey Secret
    LINTU_SMS_SIGN_NAME         阿里云控制台申请的"签名"，如 "杭州龙蟾"
    LINTU_SMS_TEMPLATE_CODE     模板编号，如 "SMS_xxxxxxxx"，模板内容须含 ${code}
    LINTU_SMS_ENDPOINT          可选 — 直接覆盖 endpoint
    LINTU_SMS_REGION            可选 — 默认走全局 dysmsapi.aliyuncs.com

User flavor 客户端：CI 用 GitHub Secrets 把凭据烤进 main.cjs，启动 sidecar
时 main 进程通过 env 转发；客户机不需要任何配置。
Dev / Ops：从终端 export 即可。

不支持 config.json — v0.2.5 已移除应用内配置入口（短信凭据是发布方资产，
不该作为客户配置项；之前的 SmsConnectTab 是设计错误）。
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
from typing import Optional

# 顶层 import — 让 PyInstaller 静态分析能 100% 看到，避免 Windows 上
# collect_all() 把 dysmsapi 子模块漏掉时 lazy import 失败。
# 失败原因记到模块级常量，下面 send_code 用。
try:
    from alibabacloud_dysmsapi20170525.client import Client as DysmsapiClient
    from alibabacloud_dysmsapi20170525 import models as dysmsapi_models
    from alibabacloud_tea_openapi import models as open_api_models
    SDK_IMPORT_ERROR: Optional[str] = None
except Exception as e:                           # noqa: BLE001 — 可能是 ImportError 也可能是 SDK 内部错误
    DysmsapiClient = None                        # type: ignore[assignment]
    dysmsapi_models = None                       # type: ignore[assignment]
    open_api_models = None                       # type: ignore[assignment]
    SDK_IMPORT_ERROR = f"{type(e).__name__}: {e}"

logger = logging.getLogger(__name__)


def _resolve(env_name: str) -> Optional[str]:
    v = os.environ.get(env_name)
    return v.strip() if v and v.strip() else None


def _get_credentials() -> dict[str, Optional[str]]:
    return {
        "access_key":    _resolve("LINTU_SMS_ACCESS_KEY"),
        "access_secret": _resolve("LINTU_SMS_ACCESS_SECRET"),
        "sign_name":     _resolve("LINTU_SMS_SIGN_NAME"),
        "template_code": _resolve("LINTU_SMS_TEMPLATE_CODE"),
        "endpoint":      _resolve("LINTU_SMS_ENDPOINT"),
        "region":        _resolve("LINTU_SMS_REGION"),
    }


def is_configured() -> bool:
    creds = _get_credentials()
    return all(creds[k] for k in ("access_key", "access_secret", "sign_name", "template_code"))


def preflight() -> dict:
    """启动期诊断 — sidecar lifespan 调一次，把 SDK / 凭据状态打到日志。
    User flavor 没装 SDK 是发版事故，必须能从 sidecar 日志里看到。"""
    has_creds = is_configured()
    flavor = os.environ.get("LINTU_BUILD_FLAVOR", "dev")
    sdk_ok = SDK_IMPORT_ERROR is None
    logger.info(
        "[sms] preflight flavor=%s sdk=%s creds=%s%s",
        flavor,
        "ok" if sdk_ok else "MISSING",
        "ok" if has_creds else "MISSING",
        f" sdk_error={SDK_IMPORT_ERROR}" if not sdk_ok else "",
    )
    return {"flavor": flavor, "sdk_ok": sdk_ok, "creds_ok": has_creds, "sdk_error": SDK_IMPORT_ERROR}


def generate_code(length: int = 6) -> str:
    return "".join(secrets.choice("0123456789") for _ in range(length))


async def send_code(phone: str, code: str) -> tuple[bool, str | None]:
    """发送验证码。返回 (ok, error_message)。

    凭据未配 / SDK 未装时按 flavor 分流：
      - dev / ops：log 验证码到 stdout 返回 (True, None)，开发联调用
      - user：返回 (False, 详细错误)，附 SDK ImportError 让客户能截图反馈
    """
    is_user_flavor = os.environ.get("LINTU_BUILD_FLAVOR") == "user"

    if SDK_IMPORT_ERROR is not None:
        logger.error("[sms] SDK import failed at module load: %s", SDK_IMPORT_ERROR)
        if is_user_flavor:
            return False, f"短信 SDK 加载失败（请反馈给开发者）：{SDK_IMPORT_ERROR}"
        logger.warning("[sms] DEV FALLBACK: phone=%s code=%s", phone, code)
        return True, None

    creds = _get_credentials()
    if not all(creds[k] for k in ("access_key", "access_secret", "sign_name", "template_code")):
        if is_user_flavor:
            logger.error("[sms] 凭据未配齐 — user 版打包没烤入凭据，需要重新发版")
            return False, "短信服务凭据未注入到当前版本，请联系开发者升级"
        logger.warning(
            "[sms] provider unconfigured — DEV FALLBACK: phone=%s code=%s",
            phone, code,
        )
        return True, None

    # endpoint 优先级：显式 endpoint > region 拼接 > 默认全局（不带 region）
    # 默认走 **dysmsapi.aliyuncs.com**（不带 region）— 开发机常见的 ClashX /
    # V2Ray fake-IP 模式 VPN 会把 dysmsapi.cn-hangzhou.aliyuncs.com 解析到
    # 198.18.x.x，TLS 直接挂。全局 endpoint 更稳。
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
