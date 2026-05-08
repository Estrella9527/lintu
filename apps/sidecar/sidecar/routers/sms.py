"""短信服务管理 — `/api/sms/*`。

提供：
  - GET  /api/sms/status              当前是否已配置 + endpoint / sign_name 概览
  - POST /api/sms/test                给一个手机号发真实测试短信（不写 sms_codes 表）

凭据用 /api/config 通用 PUT 来保存（key 名 sms_*），跟 OSS 同款。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from sidecar.providers import sms_aliyun

logger = logging.getLogger(__name__)
router = APIRouter()


def _require_platform_owner(request: Request) -> None:
    """SMS 凭据是平台级资源，仅平台超管可改 / 测试。"""
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, {"code": "unauthorized", "message": "请先登录"})
    if not (getattr(user, "is_platform_owner", False) or getattr(user, "is_root", False)):
        raise HTTPException(403, {"code": "forbidden", "message": "仅平台超级管理员可管理短信凭据"})


@router.get("/status")
async def sms_status(request: Request):
    """前端 SmsConnectTab 用 — 看当前是否已配置 + 参数概览 + 来源。

    `source` 告诉前端凭据来自哪：
      - 'env'       env 优先级生效（user 版打包烤入 / dev shell export / ops env）
      - 'config'    用户在 UI 配的，存 config.json
      - 'mixed'     两边都有，env 覆盖 config（一般是 dev 调试场景）
      - None         未配置
    """
    _require_platform_owner(request)

    import os
    creds = sms_aliyun._get_credentials()
    has_env = bool(os.environ.get("LINTU_SMS_ACCESS_KEY"))
    has_config = bool(sms_aliyun._read_config_value("sms_access_key"))
    if has_env and has_config:
        source: str | None = "mixed"
    elif has_env:
        source = "env"
    elif has_config:
        source = "config"
    else:
        source = None

    return {
        "configured": sms_aliyun.is_configured(),
        "source": source,
        "sign_name": creds.get("sign_name"),
        "template_code": creds.get("template_code"),
        # endpoint 是非敏感信息，可以直接返回；access_key / secret 不返
        "endpoint_resolved": (
            creds["endpoint"]
            or (f"dysmsapi.{creds['region']}.aliyuncs.com" if creds.get("region") else "dysmsapi.aliyuncs.com")
        ),
        # access_key 显示前 6 位 + 掩码，方便用户看到「这是上次配的那个」
        "access_key_masked": (
            creds["access_key"][:6] + "****" if creds.get("access_key") and len(creds["access_key"]) > 6 else None
        ),
    }


class TestSmsBody(BaseModel):
    phone: str


@router.post("/test")
async def sms_test(body: TestSmsBody, request: Request):
    """给指定手机号发一条测试短信。复用 send_code，但 code 用固定 999999 标记。
    返回成功 / 失败原因，让用户立刻看到「凭据是否真的对」。"""
    _require_platform_owner(request)

    if not sms_aliyun.is_configured():
        raise HTTPException(400, {
            "code": "not_configured",
            "message": "凭据还没配齐 — 先填好下面的 4 个必填字段再保存",
        })

    import re
    if not re.match(r"^1[3-9]\d{9}$", body.phone or ""):
        raise HTTPException(400, {"code": "invalid_phone", "message": "手机号格式不正确"})

    # 测试码用 999999；真实登录码靠 send_code → sms_codes 表分开
    ok, err = await sms_aliyun.send_code(body.phone, "999999")
    if not ok:
        return {"ok": False, "error": err or "未知错误"}
    return {"ok": True, "message": f"测试短信已发往 {body.phone}（测试码 999999）"}
