"""Persistent daily quota + usage accounting for /open-api/* (server mode).

Complements the in-memory RateLimitMiddleware:
  - rate_limit (in-memory) is the FAST path: rejects bursts within seconds
    of arrival, lost on process restart.
  - quota (this module, DB-persisted) is the SLOW path: counts every
    successful + errored request into api_key_usage_daily so we can
    (a) enforce daily quota across restarts, (b) display usage charts.

Quota source is api_keys.rate_limit JSON `{"per_day": N}` — same as rate_limit
middleware. We check the DB row BEFORE forwarding the request; if today's
count >= per_day we reject. After response, we increment the counter.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import Request
from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from starlette.middleware.base import BaseHTTPMiddleware

from sidecar.config import LINTU_MODE
from sidecar.db.models import ApiKeyUsageDaily
from sidecar.db.session import async_session
from sidecar.middleware.errors import error_response

logger = logging.getLogger(__name__)


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def get_today_count(key_id: str) -> int:
    async with async_session() as db:
        row = await db.execute(
            select(ApiKeyUsageDaily.count)
            .where(ApiKeyUsageDaily.key_id == key_id)
            .where(ApiKeyUsageDaily.date == _today_utc())
        )
        n = row.scalar_one_or_none()
        return int(n or 0)


async def _bump(key_id: str, *, is_error: bool) -> None:
    """UPSERT today's row with count +1 (and error_count if applicable).

    SQLite-specific upsert via ON CONFLICT. If we ever switch to PostgreSQL
    we'll swap to its dialect.
    """
    today = _today_utc()
    now = datetime.utcnow()
    async with async_session() as db:
        stmt = sqlite_insert(ApiKeyUsageDaily).values(
            key_id=key_id, date=today,
            count=1, error_count=1 if is_error else 0,
            updated_at=now,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["key_id", "date"],
            set_={
                "count": ApiKeyUsageDaily.count + 1,
                "error_count": ApiKeyUsageDaily.error_count + (1 if is_error else 0),
                "updated_at": now,
            },
        )
        await db.execute(stmt)
        await db.commit()


class QuotaMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if LINTU_MODE != "server":
            return await call_next(request)
        key = getattr(request.state, "api_key", None)
        if not key:
            return await call_next(request)

        per_day = int((key.rate_limit or {}).get("per_day") or 0)
        if per_day > 0:
            used = await get_today_count(key.key_id)
            if used >= per_day:
                return error_response(
                    status_code=429,
                    code="quota_exceeded",
                    message=f"daily quota exceeded: {used}/{per_day}",
                    request=request,
                    extra={"limit": per_day, "used": used, "scope": "day"},
                )

        response = await call_next(request)
        # Count both success and error toward daily total — they all consume
        # backend resources. error_count is broken out for the UI.
        try:
            await _bump(key.key_id, is_error=response.status_code >= 400)
        except Exception as e:
            logger.debug("quota bump failed: %s", e)
        return response
