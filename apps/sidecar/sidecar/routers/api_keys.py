"""API Key administration (Sprint 1 — CRUD only).

Auth/HMAC middleware lands in Sprint 3; this router lets the operator create
and rotate keys today, returning the plaintext secret exactly once on create
and rotate (industry standard, mirrors AWS/Stripe).
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import ApiKey, ApiKeyUsageDaily, ApiRequestLog
from sidecar.db.session import get_db

router = APIRouter()

KEY_PREFIX = "lk_live_"


def _generate_key_id() -> str:
    return KEY_PREFIX + secrets.token_hex(12)  # lk_live_ + 24 hex


def _generate_secret() -> str:
    return secrets.token_urlsafe(32)


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


class ApiKeyCreate(BaseModel):
    name: str
    client_type: str = "server"
    allowed_origins: Optional[list[str]] = None
    allowed_ips: Optional[list[str]] = None
    scopes: Optional[list[str]] = None
    rate_limit: Optional[dict] = None             # {per_minute, per_day}
    expires_at: Optional[datetime] = None
    created_by: Optional[str] = None


class ApiKeyUpdate(BaseModel):
    name: Optional[str] = None
    client_type: Optional[str] = None
    allowed_origins: Optional[list[str]] = None
    allowed_ips: Optional[list[str]] = None
    scopes: Optional[list[str]] = None
    rate_limit: Optional[dict] = None
    expires_at: Optional[datetime] = None
    is_active: Optional[bool] = None


def _to_public(k: ApiKey) -> dict:
    return {
        "id": k.id,
        "key_id": k.key_id,
        "name": k.name,
        "client_type": k.client_type,
        "allowed_origins": k.allowed_origins,
        "allowed_ips": k.allowed_ips,
        "scopes": k.scopes,
        "rate_limit": k.rate_limit,
        "quota_used": k.quota_used,
        "expires_at": k.expires_at.isoformat() if k.expires_at else None,
        "is_active": k.is_active,
        "created_by": k.created_by,
        "created_at": k.created_at.isoformat() if k.created_at else None,
        "updated_at": k.updated_at.isoformat() if k.updated_at else None,
        "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
    }


@router.get("")
async def list_keys(
    is_active: Optional[bool] = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(ApiKey).order_by(ApiKey.created_at.desc())
    if is_active is not None:
        q = q.where(ApiKey.is_active == is_active)
    rows = await db.execute(q)
    return [_to_public(k) for k in rows.scalars().all()]


@router.post("")
async def create_key(body: ApiKeyCreate, db: AsyncSession = Depends(get_db)):
    secret = _generate_secret()
    key = ApiKey(
        key_id=_generate_key_id(),
        key_secret_hash=_hash_secret(secret),
        name=body.name,
        client_type=body.client_type,
        allowed_origins=body.allowed_origins,
        allowed_ips=body.allowed_ips,
        scopes=body.scopes,
        rate_limit=body.rate_limit,
        expires_at=body.expires_at,
        created_by=body.created_by,
        is_active=True,
    )
    db.add(key)
    await db.commit()
    await db.refresh(key)
    await _enqueue_cloud_upsert(key.id)
    payload = _to_public(key)
    payload["secret"] = secret  # plaintext — shown ONCE
    payload["secret_hint"] = "Save this secret now. It will not be shown again."
    return payload


async def _enqueue_cloud_upsert(key_id: str) -> None:
    """Push key change to the cloud sidecar so UGC's auth middleware sees
    it. No-op when LINTU_CLOUD_SYNC_URL is unset."""
    try:
        from sidecar.scheduler.cloud_sync_worker import enqueue_api_key_upsert
        await enqueue_api_key_upsert(key_id)
    except Exception:
        pass


@router.get("/{key_pk}")
async def get_key(key_pk: str, db: AsyncSession = Depends(get_db)):
    key = await db.get(ApiKey, key_pk)
    if not key:
        raise HTTPException(404, "ApiKey not found")
    return _to_public(key)


@router.patch("/{key_pk}")
async def update_key(key_pk: str, body: ApiKeyUpdate, db: AsyncSession = Depends(get_db)):
    key = await db.get(ApiKey, key_pk)
    if not key:
        raise HTTPException(404, "ApiKey not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(key, field, value)
    await db.commit()
    await db.refresh(key)
    await _enqueue_cloud_upsert(key.id)
    return _to_public(key)


@router.post("/{key_pk}/rotate")
async def rotate_secret(key_pk: str, db: AsyncSession = Depends(get_db)):
    key = await db.get(ApiKey, key_pk)
    if not key:
        raise HTTPException(404, "ApiKey not found")
    secret = _generate_secret()
    key.key_secret_hash = _hash_secret(secret)
    await db.commit()
    await db.refresh(key)
    await _enqueue_cloud_upsert(key.id)
    payload = _to_public(key)
    payload["secret"] = secret
    payload["secret_hint"] = "Old secret is now invalid. Save the new secret immediately."
    return payload


@router.delete("/{key_pk}")
async def delete_key(key_pk: str, db: AsyncSession = Depends(get_db)):
    """Soft-delete by deactivating; preserves audit trail in api_request_logs."""
    key = await db.get(ApiKey, key_pk)
    if not key:
        raise HTTPException(404, "ApiKey not found")
    key.is_active = False
    await db.commit()
    await _enqueue_cloud_upsert(key.id)  # propagates is_active=False to cloud
    return {"ok": True, "deactivated": True}


@router.get("/{key_pk}/usage")
async def get_usage(
    key_pk: str,
    days: int = 30,
    db: AsyncSession = Depends(get_db),
):
    """Return per-day call counts (UTC) for the last N days, plus today's
    quota progress. Powers the DistributionCenter usage chart.
    """
    from datetime import timezone, timedelta
    key = await db.get(ApiKey, key_pk)
    if not key:
        raise HTTPException(404, "ApiKey not found")

    days = max(1, min(days, 365))
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=days - 1)

    rows = await db.execute(
        select(ApiKeyUsageDaily)
        .where(ApiKeyUsageDaily.key_id == key.key_id)
        .where(ApiKeyUsageDaily.date >= start.isoformat())
        .order_by(ApiKeyUsageDaily.date.asc())
    )
    by_date = {r.date: r for r in rows.scalars().all()}

    series = []
    total = 0
    total_errors = 0
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        row = by_date.get(d)
        cnt = int(row.count) if row else 0
        err = int(row.error_count) if row else 0
        series.append({"date": d, "count": cnt, "error_count": err})
        total += cnt
        total_errors += err

    today_iso = today.isoformat()
    today_row = by_date.get(today_iso)
    today_count = int(today_row.count) if today_row else 0
    daily_quota = int((key.rate_limit or {}).get("per_day") or 0)

    return {
        "key_id": key.key_id,
        "name": key.name,
        "days": days,
        "series": series,
        "total": total,
        "total_errors": total_errors,
        "today": {
            "date": today_iso,
            "count": today_count,
            "quota": daily_quota,
            "remaining": max(0, daily_quota - today_count) if daily_quota > 0 else None,
            "pct": (today_count / daily_quota) if daily_quota > 0 else None,
        },
        "rate_limit": key.rate_limit or {},
    }


@router.get("/{key_pk}/logs")
async def list_logs(
    key_pk: str,
    limit: int = 100,
    status_code: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
):
    key = await db.get(ApiKey, key_pk)
    if not key:
        raise HTTPException(404, "ApiKey not found")
    q = (
        select(ApiRequestLog)
        .where(ApiRequestLog.key_id == key.key_id)
        .order_by(desc(ApiRequestLog.created_at))
        .limit(min(limit, 1000))
    )
    if status_code is not None:
        q = q.where(ApiRequestLog.status_code == status_code)
    rows = await db.execute(q)
    return [
        {
            "id": r.id,
            "key_id": r.key_id,
            "method": r.method,
            "path": r.path,
            "status_code": r.status_code,
            "ip": r.ip,
            "user_agent": r.user_agent,
            "response_size": r.response_size,
            "latency_ms": r.latency_ms,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows.scalars().all()
    ]
