"""Write one ApiRequestLog row per /open-api request.

Runs in both modes (electron + server) so the operator can see all calls in
the UI's "调用日志" tab. Body capture is disabled by default for privacy
(turn on with LINTU_AUDIT_BODY=1 if you really want it).
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware

from sidecar.db.models import ApiRequestLog
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)

OPEN_API_PREFIX = "/open-api/"
CAPTURE_BODY = os.environ.get("LINTU_AUDIT_BODY", "0") == "1"
MAX_BODY_BYTES = 4096


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith(OPEN_API_PREFIX):
            return await call_next(request)

        started = time.perf_counter()
        body_for_log = None
        if CAPTURE_BODY and request.method in ("POST", "PUT", "PATCH"):
            raw = await request.body()
            if raw:
                body_for_log = _safe_decode(raw[:MAX_BODY_BYTES])

        try:
            response = await call_next(request)
        except Exception:
            await self._record(
                request, status_code=500, latency_ms=int((time.perf_counter() - started) * 1000),
                response_size=0, body=body_for_log,
            )
            raise

        latency_ms = int((time.perf_counter() - started) * 1000)
        size = int(response.headers.get("content-length") or 0)
        await self._record(
            request, status_code=response.status_code, latency_ms=latency_ms,
            response_size=size, body=body_for_log,
        )
        return response

    async def _record(self, request: Request, *, status_code: int, latency_ms: int, response_size: int, body):
        try:
            key = getattr(request.state, "api_key", None)
            key_id = key.key_id if key else None
            ip = request.client.host if request.client else None
            ua = request.headers.get("user-agent")
            async with async_session() as db:  # type: AsyncSession
                db.add(ApiRequestLog(
                    key_id=key_id,
                    method=request.method,
                    path=request.url.path,
                    status_code=status_code,
                    ip=ip,
                    user_agent=ua,
                    request_body=body,
                    response_size=response_size,
                    latency_ms=latency_ms,
                    created_at=datetime.utcnow(),
                ))
                await db.commit()
        except Exception as e:
            logger.debug("audit log write failed: %s", e)


def _safe_decode(data: bytes) -> dict | None:
    """Best-effort body decode for audit; redact obvious secret-looking keys."""
    try:
        import json
        decoded = json.loads(data.decode("utf-8", errors="replace"))
    except Exception:
        return {"_raw_preview": data[:200].decode("utf-8", errors="replace")}
    if isinstance(decoded, dict):
        for k in list(decoded.keys()):
            kl = k.lower()
            if "secret" in kl or "password" in kl or "token" in kl or "api_key" in kl:
                decoded[k] = "***"
    return decoded


# ── 操作日志中间件（用户系统 Phase 1） ──────────────────────────────────────
#
# 替代权限"事前阻止"的"事后追溯"。Phase 1 不做角色拆分，但每个写操作必须留
# 痕，便于「谁动了我的标签 / 提示词 / 配置」回溯。
#
# 写入条件（同时满足）：
#   - 路径在 /api/* 下（不含 /api/auth/sms/send 这种高频低价值）
#   - method ∈ {POST, PUT, PATCH, DELETE}
#   - request.state.user 存在（未登录的不记，避免 ops bypass 全站噪声）
#       — 例外：root 用户操作要记，因为 ops 干预客户数据需要审计

API_PREFIX = "/api/"

# 跳过这些 path 不写操作日志（噪声 / 隐私敏感）
OP_LOG_SKIP_PATHS = {
    "/api/auth/sms/send",
    "/api/auth/sms/verify",
    "/api/auth/refresh",
    "/api/auth/me",
    "/api/auth/logout",
}


class OperationLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method

        is_writable = method in ("POST", "PUT", "PATCH", "DELETE")
        in_api = path.startswith(API_PREFIX)
        if not (is_writable and in_api) or path in OP_LOG_SKIP_PATHS:
            return await call_next(request)

        # body hash（不存原始）— 用于审计排重
        body_hash = None
        try:
            raw = await request.body()
            if raw:
                import hashlib
                body_hash = hashlib.sha256(raw).hexdigest()[:32]
        except Exception:
            pass

        response = await call_next(request)

        # user 可能是真实 User 对象，也可能是 SYSTEM_ROOT（ops bypass）
        user = getattr(request.state, "user", None)
        if user is None:
            return response   # 未登录 / 鉴权未挂 — 跳过记录

        try:
            user_id = getattr(user, "id", None)
            project_id = request.headers.get("x-project-id") or None
            ip = request.client.host if request.client else None
            ua = (request.headers.get("user-agent") or "")[:200]
            async with async_session() as db:
                from sidecar.db.models import OperationLog
                db.add(OperationLog(
                    user_id=user_id,
                    project_id=project_id,
                    method=method,
                    path=path,
                    status_code=response.status_code,
                    summary=f"{method} {path}",
                    request_body_hash=body_hash,
                    ip=ip,
                    user_agent=ua,
                ))
                await db.commit()
        except Exception as e:
            logger.debug("op log write failed: %s", e)

        return response
