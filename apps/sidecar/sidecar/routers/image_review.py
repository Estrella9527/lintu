"""Pre-publish review queue for AI-generated images.

Workflow:
  1. batch_engine writes new AI images with `review_status='pending'`
  2. Operator opens 桌面端→「审核」 module, sees pending grid
  3. Operator picks N images, clicks 通过 / 拒绝 / 跳过
  4. Approved → eligible for matching + cloud sync
     Rejected → hidden from matching, never pushed to cloud
     Skipped  → stays pending (re-shown next time)

Endpoints:
  GET  /api/image-review/queue   — list pending (paginated, filterable)
  GET  /api/image-review/counts  — pending count (for sidebar badge)
  POST /api/image-review/decide  — batch approve / reject / skip
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image
from sidecar.db.session import get_db

router = APIRouter()

VALID_DECISIONS = {"approved", "rejected", "skipped"}


@router.get("/queue")
async def list_review_queue(
    project_id: Optional[str] = None,
    status: str = "pending",
    offset: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    """List images by review_status. Defaults to pending; pass status=rejected
    to inspect what's been hidden from matching, status=approved for audit."""
    if status not in {"pending", "approved", "rejected", "skipped"}:
        raise HTTPException(400, "invalid status")
    limit = max(1, min(int(limit), 200))

    q = (
        select(Image)
        .where(Image.review_status == status)
        .where(Image.source_type == "generated")  # review queue is AI-only
    )
    if project_id:
        q = q.where(Image.project_id == project_id)

    total = await db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = await db.execute(
        q.order_by(Image.created_at.desc()).offset(offset).limit(limit)
    )
    items = rows.scalars().all()

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": [
            {
                "id": img.id,
                "project_id": img.project_id,
                "file_name": img.file_name,
                "width": img.width,
                "height": img.height,
                "blur_score": img.blur_score,
                "parent_id": img.parent_id,
                "review_status": img.review_status,
                "reviewed_at": img.reviewed_at.isoformat() if img.reviewed_at else None,
                "generation_metadata": img.generation_metadata,
                "created_at": img.created_at.isoformat() if img.created_at else None,
            }
            for img in items
        ],
    }


@router.get("/counts")
async def review_counts(
    project_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Pending count for sidebar badge + summary stats for the queue page."""
    base = select(Image).where(Image.source_type == "generated")
    if project_id:
        base = base.where(Image.project_id == project_id)

    out = {}
    for s in ("pending", "approved", "rejected", "skipped"):
        q = base.where(Image.review_status == s)
        out[s] = await db.scalar(select(func.count()).select_from(q.subquery())) or 0
    return out


class DecideBody(BaseModel):
    image_ids: list[str]
    decision: str   # 'approved' | 'rejected' | 'skipped'


@router.post("/decide")
async def decide(body: DecideBody, db: AsyncSession = Depends(get_db)):
    """Batch decision endpoint. Returns the count actually updated.

    Side effects:
      - approved → enqueue cloud_sync (so the cloud sidecar gets the image
        within ~30s of approval). Idempotent — already-pushed rows are no-ops.
      - rejected → no cloud sync; stays local-only
      - skipped  → no cloud sync; will reappear in queue next time
    """
    if body.decision not in VALID_DECISIONS:
        raise HTTPException(400, f"decision must be one of {VALID_DECISIONS}")
    if not body.image_ids:
        return {"ok": True, "updated": 0}

    # 拒审前先记下哪些"原本是已发布(approved)"的图 —— 它们可能已在云端,
    # 改判 rejected 后必须从云端撤下(进墓碑),否则 UGC 永远收不到移除信号。
    prev_approved: list[str] = []
    if body.decision == "rejected":
        prev_approved = [
            r[0] for r in (await db.execute(
                select(Image.id).where(Image.id.in_(body.image_ids))
                .where(Image.review_status == "approved")
            )).all()
        ]

    result = await db.execute(
        update(Image)
        .where(Image.id.in_(body.image_ids))
        .values(review_status=body.decision, reviewed_at=datetime.utcnow())
    )
    await db.commit()
    updated = result.rowcount or 0

    try:
        if body.decision == "approved":
            # 通过 → 推云端(~30s 内到达;已推过的幂等无副作用)
            from sidecar.scheduler.cloud_sync_worker import enqueue_image_upsert
            for iid in body.image_ids:
                await enqueue_image_upsert(iid)
        elif prev_approved:
            # 已发布图被拒审 → 推删除,云端写墓碑,UGC 经 deleted_ids 移出候选池
            from sidecar.scheduler.cloud_sync_worker import enqueue_image_delete
            for iid in prev_approved:
                await enqueue_image_delete(iid)
    except Exception:
        pass

    return {"ok": True, "updated": updated, "decision": body.decision}
