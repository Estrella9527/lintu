"""Auth middleware for /open-api/* (server mode only).

Current build supports **Bearer** credentials:

    Authorization: Bearer lk_live_xxx.<secret>

The plaintext secret is required on every call. This is appropriate for
server-to-server callers (a backend proxy running on a trusted host) but
not for browsers — never embed the secret in JS shipped to a client.

HMAC signing (PRD §5.3) is planned: it requires the server to recover the
secret to recompute signatures. Implementation gates on adding an
encrypted-at-rest secret store; until then the createKey route returns the
plaintext secret once and the verifier compares its sha256 against
api_keys.key_secret_hash.

Skipped paths (always public): /open-api/v1/health
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Optional

from fastapi import Request
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware

from sidecar.config import LINTU_MODE
from sidecar.db.models import ApiKey
from sidecar.db.session import async_session
from sidecar.middleware.errors import error_response

logger = logging.getLogger(__name__)

OPEN_API_PREFIX = "/open-api/"
PUBLIC_PATHS = {"/open-api/v1/health"}


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


async def _load_active_key(key_id: str) -> Optional[ApiKey]:
    async with async_session() as db:
        rows = await db.execute(
            select(ApiKey)
            .where(ApiKey.key_id == key_id)
            .where(ApiKey.is_active.is_(True))
        )
        key = rows.scalar_one_or_none()
        if key:
            db.expunge(key)
        return key


def _origin_allowed(origin: str, allowed: list[str]) -> bool:
    for pattern in allowed:
        if pattern == origin:
            return True
        if pattern.startswith("*.") and origin.endswith(pattern[1:]):
            return True
    return False


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if LINTU_MODE != "server":
            return await call_next(request)
        if not path.startswith(OPEN_API_PREFIX) or path in PUBLIC_PATHS:
            return await call_next(request)

        key, error = await self._authenticate(request)
        if error:
            return error_response(
                status_code=401, code="unauthorized", message=error, request=request,
            )

        if key.allowed_origins:
            origin = request.headers.get("origin", "")
            if origin and not _origin_allowed(origin, key.allowed_origins):
                return error_response(
                    status_code=403, code="forbidden_origin",
                    message=f"origin not allowed: {origin}", request=request,
                )
        if key.allowed_ips:
            ip = request.client.host if request.client else ""
            if ip and ip not in key.allowed_ips:
                return error_response(
                    status_code=403, code="forbidden_ip",
                    message=f"ip not allowed: {ip}", request=request,
                )

        request.state.api_key = key
        return await call_next(request)

    async def _authenticate(self, request: Request):
        auth_header = request.headers.get("authorization") or ""
        if not auth_header.lower().startswith("bearer "):
            return None, "missing or non-bearer credentials"
        token = auth_header[7:].strip()
        if "." not in token:
            return None, "malformed token (expected lk_live_xxx.<secret>)"
        key_id, secret = token.split(".", 1)
        key = await _load_active_key(key_id)
        if not key or key.key_secret_hash != _hash_secret(secret):
            return None, "invalid credentials"
        if key.expires_at and key.expires_at.timestamp() < time.time():
            return None, "key expired"
        return key, None
