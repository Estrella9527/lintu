"""Tagger A/B audit — re-tag a small sample with a stronger provider and
record the agreement score.

Triggered fire-and-forget from `engines/tagger.py` after each successful
primary tag, gated by `tagger_audit_provider` + `tagger_audit_sample_rate`.

Stored as `TagAuditLog` rows; aggregated by `routers/tag_audit.py`.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Any

from sqlalchemy import select

from sidecar.db.models import Image, Tag, TagAuditLog
from sidecar.db.session import async_session
from sidecar.engines.image_utils import effective_file_path
from sidecar.defaults import get_setting
from sidecar.routers.tag_schema import _read_schema

logger = logging.getLogger(__name__)


def _normalize_tags(payload: dict | None, *, schema: dict | None = None) -> dict[str, set[str]]:
    """Coerce a tagger response into {dimension: {value, ...}} for comparison.

    - String values become single-element sets.
    - Lists become sets.
    - Drops `description` and any non-schema dimensions.
    """
    if not isinstance(payload, dict):
        return {}
    allowed = set(schema.keys()) if schema else None
    out: dict[str, set[str]] = {}
    for k, v in payload.items():
        if k == "description":
            continue
        if allowed is not None and k not in allowed:
            continue
        if isinstance(v, list):
            out[k] = {str(x).strip() for x in v if str(x).strip()}
        elif isinstance(v, str):
            s = v.strip()
            if s:
                out[k] = {s}
        # ignore other types
    return out


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 1.0


def _score(primary: dict[str, set[str]], audit: dict[str, set[str]]) -> tuple[float, dict[str, float]]:
    dims = set(primary.keys()) | set(audit.keys())
    if not dims:
        return 1.0, {}
    per_dim = {d: _jaccard(primary.get(d, set()), audit.get(d, set())) for d in dims}
    overall = sum(per_dim.values()) / len(per_dim)
    return overall, per_dim


def _resolve_audit_provider():
    """Build an ImageProvider for the configured audit target.

    Uses the same legacy resolver as tagger._get_provider, but with the
    audit-specific config keys.
    """
    from sidecar.engines.tagger import _get_provider as _resolve

    target = (get_setting("tagger_audit_provider") or "").strip()
    if not target:
        return None, None
    if target.startswith("relay:"):
        target = target[len("relay:"):]
    provider = _resolve(target)
    model_override = (get_setting("tagger_audit_model_override") or "").strip()
    if model_override and hasattr(provider, "model"):
        provider.model = model_override
    return provider, getattr(provider, "model", None)


async def audit_image(
    image_id: str,
    primary_tags_payload: dict,
    primary_provider_name: str,
    primary_model: str | None,
    *,
    prompt: str,
) -> None:
    """Run the audit provider on `image_id` and record the result.

    Idempotent failure: any exception is logged and stored as status='error'
    so we never break the main tagging pipeline.
    """
    audit_provider, audit_model = _resolve_audit_provider()
    if audit_provider is None:
        return

    audit_provider_name = (get_setting("tagger_audit_provider") or "").strip()
    schema = _read_schema()
    primary_norm = _normalize_tags(primary_tags_payload, schema=schema)

    audit_payload: dict = {}
    status = "ok"
    error: str | None = None
    overall = 0.0
    per_dim: dict[str, float] = {}

    try:
        # Fetch the image path
        async with async_session() as db:
            row = await db.execute(select(Image).where(Image.id == image_id))
            img = row.scalar_one_or_none()
            if img is None:
                return
            file_path = effective_file_path(img)

        result = await audit_provider.tag_image(file_path, prompt)
        audit_payload = result.get("tags") or {}
        audit_norm = _normalize_tags(audit_payload, schema=schema)
        overall, per_dim = _score(primary_norm, audit_norm)
        if overall < 0.6:
            status = "mismatch"
    except Exception as e:
        status = "error"
        error = str(e)[:500]
        logger.warning("tag_audit failed for image %s: %s", image_id, e)

    # Persist
    try:
        async with async_session() as db:
            db.add(TagAuditLog(
                image_id=image_id,
                primary_provider=primary_provider_name,
                primary_model=primary_model,
                primary_tags=primary_tags_payload,
                audit_provider=audit_provider_name,
                audit_model=audit_model,
                audit_tags=audit_payload,
                jaccard=overall,
                per_dimension=per_dim,
                status=status,
                error=error,
                created_at=datetime.utcnow(),
            ))
            await db.commit()
    except Exception as e:
        logger.error("Failed to persist tag_audit row: %s", e)


def maybe_schedule_audit(
    image_id: str,
    primary_tags_payload: dict,
    primary_provider_name: str,
    primary_model: str | None,
    *,
    prompt: str,
) -> None:
    """Sample-rate gated, fire-and-forget. Called inline from tagger after
    each successful tag. Returns immediately; the audit runs in the background.
    """
    import random
    audit_provider_name = (get_setting("tagger_audit_provider") or "").strip()
    if not audit_provider_name:
        return
    if audit_provider_name == primary_provider_name or audit_provider_name == f"relay:{primary_provider_name}":
        return  # nothing to compare against
    rate = float(get_setting("tagger_audit_sample_rate") or 0.0)
    if rate <= 0:
        return
    if random.random() >= rate:
        return
    asyncio.create_task(audit_image(
        image_id, primary_tags_payload, primary_provider_name, primary_model, prompt=prompt,
    ))
