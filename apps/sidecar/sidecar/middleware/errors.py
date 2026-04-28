"""Standard error envelope for /open-api/* responses.

Every customer-facing failure returns:

    {
      "error": {
        "code": "invalid_request" | "unauthorized" | "forbidden_scope" | ...,
        "message": "human-readable description",
        "request_id": "req_<uuid>",
        ...optional fields...
      }
    }

This module:
  - exports `error_response()` for middleware that needs to emit envelopes
    directly (rate_limit, quota, auth)
  - registers FastAPI exception handlers to wrap HTTPException + generic
    exceptions in the same envelope (so endpoint code can keep using
    raise HTTPException(403, ...))

Internal /api/* admin routes are NOT wrapped — they're for the local
desktop UI and use the default FastAPI envelope.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

OPEN_API_PREFIX = "/open-api/"


def _request_id(request: Request) -> str:
    rid = getattr(request.state, "request_id", None)
    if rid:
        return rid
    rid = "req_" + uuid.uuid4().hex[:16]
    try:
        request.state.request_id = rid
    except Exception:
        pass
    return rid


def error_response(
    *,
    status_code: int,
    code: str,
    message: str,
    request: Request,
    extra: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    payload: dict[str, Any] = {
        "error": {
            "code": code,
            "message": message,
            "request_id": _request_id(request),
        }
    }
    if extra:
        payload["error"].update(extra)
    return JSONResponse(payload, status_code=status_code, headers=headers or {})


_HTTP_STATUS_TO_CODE = {
    400: "invalid_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    408: "timeout",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "invalid_request",
    429: "rate_limited",
    500: "internal_error",
    502: "bad_gateway",
    503: "service_unavailable",
    504: "gateway_timeout",
}


def _coerce_detail(detail: Any) -> tuple[str, dict[str, Any]]:
    """Some endpoints raise HTTPException(403, {"code": "...", "message": "..."}) —
    honour their structure when present; otherwise fall back to a string.
    Returns (message, extra_fields_to_merge)."""
    if isinstance(detail, dict):
        msg = str(detail.get("message") or detail.get("detail") or "")
        extra = {k: v for k, v in detail.items() if k not in ("message", "detail", "code")}
        if "code" in detail:
            extra["_explicit_code"] = detail["code"]
        return msg, extra
    return str(detail), {}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        if not request.url.path.startswith(OPEN_API_PREFIX):
            # Pass through default envelope for internal /api/* admin routes.
            return JSONResponse(
                {"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers,
            )
        message, extra = _coerce_detail(exc.detail)
        code = extra.pop("_explicit_code", None) or _HTTP_STATUS_TO_CODE.get(exc.status_code, "error")
        return error_response(
            status_code=exc.status_code, code=code, message=message,
            request=request, extra=extra, headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        if not request.url.path.startswith(OPEN_API_PREFIX):
            return JSONResponse({"detail": exc.errors()}, status_code=422)
        return error_response(
            status_code=422, code="invalid_request",
            message="request validation failed", request=request,
            extra={"errors": exc.errors()},
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("Unhandled exception on %s", request.url.path)
        if not request.url.path.startswith(OPEN_API_PREFIX):
            return JSONResponse({"detail": "internal server error"}, status_code=500)
        return error_response(
            status_code=500, code="internal_error",
            message="an internal error occurred; quote request_id when reporting",
            request=request,
        )
