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
