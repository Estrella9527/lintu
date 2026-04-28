"""Scope-based authorization for /open-api/* endpoints (server mode).

Auth middleware validates the bearer credentials and attaches the ApiKey
object to `request.state.api_key`. This module turns those scopes into a
FastAPI dependency so per-endpoint declarations stay declarative:

    @router.post(
        "/images/match",
        dependencies=[Depends(require_scope("images:match"))],
    )

Available scopes (canonical):
    images:read     — list / detail / file
    images:download — full-resolution download
    images:match    — text→image semantic match
    tags:read       — tag distributions / matrix
    stats:read      — dashboard counters
    batches:read    — batch metadata
    batches:write   — submit batch via API

A key with `["*"]` in its scopes list is treated as super-key (only useful
for owner-issued admin tokens; do not give to external customers).

In electron mode this dependency is a no-op so the desktop UI keeps working
without scope-checking the local API.
"""
from __future__ import annotations

from typing import Iterable

from fastapi import HTTPException, Request

from sidecar.config import LINTU_MODE


def _key_has_scope(key_scopes: Iterable[str] | None, required: str) -> bool:
    if not key_scopes:
        return False
    if "*" in key_scopes:
        return True
    return required in key_scopes


def require_scope(*required_scopes: str):
    """Return a FastAPI dependency that enforces the given scope(s).

    Multiple scopes are AND-ed: caller must hold every one. Use multiple
    `dependencies=[Depends(require_scope(...))]` entries instead if you want
    OR semantics.
    """
    def _dep(request: Request) -> None:
        if LINTU_MODE != "server":
            return
        key = getattr(request.state, "api_key", None)
        if not key:
            # Auth middleware should have rejected this already; defensive
            raise HTTPException(
                status_code=401,
                detail={"code": "unauthorized", "message": "missing api key"},
            )
        scopes = key.scopes or []
        for s in required_scopes:
            if not _key_has_scope(scopes, s):
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "forbidden_scope",
                        "message": f"this api key is missing required scope: {s}",
                        "required_scope": s,
                        "key_scopes": list(scopes),
                    },
                )
    return _dep
