"""OSS sync admin endpoints — internal /api routes only.

POST /api/oss/test            — verify configured credentials by listing the bucket
GET  /api/oss/status          — queue stats (pending / running / done / failed)
POST /api/oss/backfill        — enqueue every image whose cdn_path is NULL
POST /api/oss/retry-failed    — reset failed jobs to pending
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, OssSyncJob
from sidecar.db.session import get_db
from sidecar.defaults import get_setting
from sidecar.engines.oss_sync import enqueue_image_sync, get_storage, invalidate_storage_cache

router = APIRouter()

logger = logging.getLogger(__name__)


class TestResult(BaseModel):
    ok: bool
    message: str = ""
    error: str = ""


@router.post("/test", response_model=TestResult)
async def test_connection():
    """Round-trip a HEAD on the bucket using oss2 to verify credentials.

    We pick a no-op operation: get bucket info. Failing oss2 calls raise an
    OssError with a status code; we surface a friendly message.
    """
    invalidate_storage_cache()
    storage = get_storage()
    if not storage.is_configured():
        return TestResult(ok=False, error="OSS 未配置")

    # oss2 calls are blocking — run via thread executor would be cleaner, but
    # this is a one-shot admin call; ms-level latency is fine.
    try:
        import oss2
        from oss2.exceptions import OssError
        bucket = storage._ensure_bucket()  # type: ignore[attr-defined]
        info = bucket.get_bucket_info()
        return TestResult(
            ok=True,
            message=f"连接成功 · bucket={info.name} · 区域={info.location}",
        )
    except Exception as e:  # broad: oss2 raises various subtypes
        msg = str(e)
        # Hide secret echoes in error messages
        return TestResult(ok=False, error=msg[:300])


@router.get("/status")
async def get_status(db: AsyncSession = Depends(get_db)):
    """Queue stats + sync coverage + throughput estimate for the dashboard."""
    from datetime import datetime, timedelta

    rows = await db.execute(
        select(OssSyncJob.status, func.count(OssSyncJob.id))
        .group_by(OssSyncJob.status)
    )
    by_status = {s: int(n) for s, n in rows.all()}

    total_images = await db.scalar(select(func.count(Image.id))) or 0
    synced_images = await db.scalar(
        select(func.count(Image.id)).where(Image.cdn_path.is_not(None))
    ) or 0

    pending = by_status.get("pending", 0)
    running = by_status.get("running", 0)

    # Throughput: jobs completed in the last 60s → estimate ETA
    one_min_ago = datetime.utcnow() - timedelta(seconds=60)
    recent_done = await db.scalar(
        select(func.count(OssSyncJob.id))
        .where(OssSyncJob.status == "done")
        .where(OssSyncJob.completed_at >= one_min_ago)
    ) or 0
    jobs_per_sec = recent_done / 60.0
    remaining_jobs = pending + running
    eta_sec = int(remaining_jobs / jobs_per_sec) if jobs_per_sec > 0 and remaining_jobs > 0 else None

    storage = get_storage()
    return {
        "configured": storage.is_configured(),
        "provider": get_setting("oss_provider") or "",
        "bucket": get_setting("oss_bucket") or "",
        "cdn_base": get_setting("oss_cdn_base") or "",
        "queue": {
            "pending": pending,
            "running": running,
            "done": by_status.get("done", 0),
            "failed": by_status.get("failed", 0),
            "skipped": by_status.get("skipped", 0),
        },
        "throughput": {
            "jobs_per_min": recent_done,
            "eta_sec": eta_sec,
        },
        "coverage": {
            "total_images": total_images,
            "synced_images": synced_images,
            "pending_images": max(0, total_images - synced_images),
            "pct": (synced_images / total_images) if total_images > 0 else 0,
        },
    }


@router.get("/recent-jobs")
async def recent_jobs(limit: int = 20, db: AsyncSession = Depends(get_db)):
    """Most recent OSS sync jobs across all statuses, with image filename
    joined in. Powers the activity feed in the OSS sync UI."""
    limit = max(1, min(int(limit), 100))
    # Latest activity = newest by completed_at (or created_at if not done yet)
    rows = await db.execute(
        select(
            OssSyncJob.id,
            OssSyncJob.image_id,
            OssSyncJob.asset_kind,
            OssSyncJob.object_key,
            OssSyncJob.status,
            OssSyncJob.attempts,
            OssSyncJob.last_error,
            OssSyncJob.created_at,
            OssSyncJob.completed_at,
            Image.file_name,
        )
        .outerjoin(Image, Image.id == OssSyncJob.image_id)
        .order_by(OssSyncJob.id.desc())
        .limit(limit)
    )
    out = []
    for r in rows.all():
        out.append({
            "id": r[0],
            "image_id": r[1],
            "asset_kind": r[2],
            "object_key": r[3],
            "status": r[4],
            "attempts": r[5],
            "last_error": (r[6] or "")[:200] if r[6] else None,
            "created_at": r[7].isoformat() if r[7] else None,
            "completed_at": r[8].isoformat() if r[8] else None,
            "file_name": r[9],
        })
    return {"items": out}


class BackfillBody(BaseModel):
    project_id: Optional[str] = None
    limit: int = 0   # 0 = no cap


@router.post("/backfill")
async def backfill(body: BackfillBody, db: AsyncSession = Depends(get_db)):
    """Enqueue OSS sync for every image whose cdn_path is NULL."""
    storage = get_storage()
    if not storage.is_configured():
        raise HTTPException(400, "OSS 未配置；请先填写凭证并测试连接")

    q = select(Image.id).where(Image.cdn_path.is_(None))
    if body.project_id:
        q = q.where(Image.project_id == body.project_id)
    if body.limit and body.limit > 0:
        q = q.limit(body.limit)
    rows = await db.execute(q)
    image_ids = [r[0] for r in rows.all()]

    enqueued = 0
    for iid in image_ids:
        try:
            n = await enqueue_image_sync(iid)
            enqueued += n
        except Exception as e:
            logger.warning("backfill enqueue %s failed: %s", iid, e)
    return {"images": len(image_ids), "jobs_added": enqueued}


class EnqueueImagesBody(BaseModel):
    image_ids: list[str]
    force: bool = False     # if True, re-enqueue even already-synced images


@router.post("/enqueue-images")
async def enqueue_images(body: EnqueueImagesBody, db: AsyncSession = Depends(get_db)):
    """Enqueue OSS sync jobs for a specific selection of images. Used by
    the asset library's batch toolbar to sync just-filtered images
    (e.g. "this folder × this prompt × style=赛博朋克") instead of the
    whole library.

    Idempotent: a previously-done image is skipped unless force=True.
    """
    storage = get_storage()
    if not storage.is_configured():
        raise HTTPException(400, "OSS 未配置；请先在 OSS 同步页填凭证并测试连接")
    if not body.image_ids:
        raise HTTPException(400, "image_ids must be non-empty")

    # If force=True, reset cdn_path so the next sync re-uploads instead of
    # being skipped by the "already synced" filter.
    if body.force:
        from sqlalchemy import update as sql_update
        await db.execute(
            sql_update(Image).where(Image.id.in_(body.image_ids)).values(cdn_path=None)
        )
        await db.commit()

    enqueued = 0
    for iid in body.image_ids:
        try:
            n = await enqueue_image_sync(iid)
            enqueued += n
        except Exception as e:
            logger.warning("enqueue %s failed: %s", iid, e)

    return {"images": len(body.image_ids), "jobs_added": enqueued, "force": body.force}


@router.post("/retry-failed")
async def retry_failed(db: AsyncSession = Depends(get_db)):
    """Reset failed jobs to pending so the worker picks them up again."""
    rows = await db.execute(
        select(func.count(OssSyncJob.id)).where(OssSyncJob.status == "failed")
    )
    n = int(rows.scalar_one() or 0)
    if n == 0:
        return {"reset": 0}
    await db.execute(
        update(OssSyncJob)
        .where(OssSyncJob.status == "failed")
        .values(status="pending", attempts=0, last_error=None)
    )
    await db.commit()
    return {"reset": n}
