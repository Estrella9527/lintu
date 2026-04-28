"""Per-API-key rate limiting (server mode, /open-api/* only).

In-memory sliding window — single process, good enough for the MVP. Two
windows are tracked per key:

  - per_minute: rolling 60s window
  - per_day:    rolling 86_400s window

Configured per key via api_keys.rate_limit JSON: {"per_minute": 60, "per_day": 10000}.
A key without limits is unrestricted.
"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from sidecar.config import LINTU_MODE
from sidecar.middleware.errors import error_response

WINDOW_MINUTE = 60
WINDOW_DAY = 86_400


class RateLimiter:
    def __init__(self):
        self._timestamps: dict[str, deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def check(self, key_id: str, limits: dict | None) -> tuple[bool, str | None]:
        if not limits:
            return True, None
        per_min = int(limits.get("per_minute") or 0)
        per_day = int(limits.get("per_day") or 0)
        if per_min <= 0 and per_day <= 0:
            return True, None

        now = time.time()
        async with self._lock:
            window = self._timestamps[key_id]
            # Drop entries older than the longest window we track
            cutoff = now - WINDOW_DAY
            while window and window[0] < cutoff:
                window.popleft()

            if per_min > 0:
                cnt = sum(1 for t in window if t >= now - WINDOW_MINUTE)
                if cnt >= per_min:
                    return False, f"rate limit: {per_min}/min"
            if per_day > 0 and len(window) >= per_day:
                return False, f"rate limit: {per_day}/day"

            window.append(now)
        return True, None


limiter = RateLimiter()


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if LINTU_MODE != "server":
            return await call_next(request)
        key = getattr(request.state, "api_key", None)
        if not key:
            return await call_next(request)
        ok, msg = await limiter.check(key.key_id, key.rate_limit)
        if not ok:
            return error_response(
                status_code=429, code="rate_limited", message=msg or "rate limit exceeded",
                request=request, headers={"Retry-After": "60"},
            )
        return await call_next(request)
