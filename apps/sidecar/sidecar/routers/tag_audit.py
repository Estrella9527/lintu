"""Tagger A/B audit — read-side stats and recent samples."""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Query
from sqlalchemy import desc, func, select

from sidecar.db.models import TagAuditLog
from sidecar.db.session import async_session
from sidecar.defaults import get_setting

router = APIRouter()


@router.get("/stats")
async def stats(window_hours: int = Query(default=168, ge=1, le=720)):
    """Aggregate metrics over the last `window_hours` (default 7 days)."""
    since = datetime.utcnow() - timedelta(hours=window_hours)
    async with async_session() as db:
        rows = (await db.execute(
            select(TagAuditLog).where(TagAuditLog.created_at >= since)
        )).scalars().all()

    if not rows:
        return {
            "enabled": bool(get_setting("tagger_audit_provider")),
            "audit_provider": get_setting("tagger_audit_provider") or None,
            "sample_rate": get_setting("tagger_audit_sample_rate"),
            "total": 0,
            "ok": 0,
            "mismatch": 0,
            "error": 0,
            "avg_jaccard": None,
            "per_dimension_avg": {},
            "window_hours": window_hours,
        }

    total = len(rows)
    ok = sum(1 for r in rows if r.status == "ok")
    mismatch = sum(1 for r in rows if r.status == "mismatch")
    error = sum(1 for r in rows if r.status == "error")
    valid_scores = [r.jaccard for r in rows if r.status != "error"]
    avg_j = (sum(valid_scores) / len(valid_scores)) if valid_scores else None

    # Per-dimension average (only on non-error rows)
    per_dim_sum: dict[str, float] = {}
    per_dim_n: dict[str, int] = {}
    for r in rows:
        if r.status == "error" or not isinstance(r.per_dimension, dict):
            continue
        for d, j in r.per_dimension.items():
            per_dim_sum[d] = per_dim_sum.get(d, 0.0) + float(j)
            per_dim_n[d] = per_dim_n.get(d, 0) + 1
    per_dim_avg = {d: per_dim_sum[d] / per_dim_n[d] for d in per_dim_sum}

    return {
        "enabled": True,
        "audit_provider": get_setting("tagger_audit_provider") or None,
        "sample_rate": get_setting("tagger_audit_sample_rate"),
        "total": total,
        "ok": ok,
        "mismatch": mismatch,
        "error": error,
        "avg_jaccard": avg_j,
        "per_dimension_avg": per_dim_avg,
        "window_hours": window_hours,
    }


@router.get("/recent")
async def recent(limit: int = Query(default=50, ge=1, le=500), status: str | None = None):
    async with async_session() as db:
        q = select(TagAuditLog).order_by(desc(TagAuditLog.created_at)).limit(limit)
        if status:
            q = q.where(TagAuditLog.status == status)
        rows = (await db.execute(q)).scalars().all()

    return [
        {
            "id": r.id,
            "image_id": r.image_id,
            "primary_provider": r.primary_provider,
            "primary_model": r.primary_model,
            "primary_tags": r.primary_tags,
            "audit_provider": r.audit_provider,
            "audit_model": r.audit_model,
            "audit_tags": r.audit_tags,
            "jaccard": r.jaccard,
            "per_dimension": r.per_dimension,
            "status": r.status,
            "error": r.error,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.post("/run-now")
async def run_now(image_ids: list[str], audit_provider: str | None = None):
    """Manually trigger an audit on a specific set of images. Useful for
    one-off spot-checks before relying on the sample-rate gate."""
    from sidecar.db.models import Image, Tag
    from sidecar.engines.tag_audit import audit_image
    from sidecar.engines.tagger import _build_prompt_from_schema

    if not image_ids:
        return {"ok": False, "error": "请提供至少一张图片 ID"}

    # Override audit provider for this run if requested
    if audit_provider:
        from sidecar.routers.config_api import _read_config, _write_config
        cfg = _read_config()
        prev = cfg.get("tagger_audit_provider", "")
        cfg["tagger_audit_provider"] = audit_provider
        _write_config(cfg)

    queued = 0
    prompt = _build_prompt_from_schema()
    async with async_session() as db:
        rows = (await db.execute(select(Image).where(Image.id.in_(image_ids)))).scalars().all()
        # Reconstruct primary_tags payload from the Tag table
        tag_rows = (await db.execute(select(Tag).where(Tag.image_id.in_(image_ids)))).scalars().all()

    by_image: dict[str, dict[str, list[str]]] = {}
    for t in tag_rows:
        by_image.setdefault(t.image_id, {}).setdefault(t.dimension, []).append(t.value)

    for img in rows:
        primary = by_image.get(img.id, {})
        if img.description:
            primary["description"] = img.description
        await audit_image(
            img.id,
            primary,
            (img.tag_provider or "unknown"),
            None,
            prompt=prompt,
        )
        queued += 1

    if audit_provider:
        cfg["tagger_audit_provider"] = prev
        _write_config(cfg)

    return {"ok": True, "audited": queued}
