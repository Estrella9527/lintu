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

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, UploadBatch
from sidecar.db.session import get_db

logger = logging.getLogger(__name__)

router = APIRouter()

VALID_DECISIONS = {"approved", "rejected", "skipped"}


def _current_user_id(request: Request) -> Optional[str]:
    return getattr(getattr(request.state, "user", None), "id", None)


@router.get("/queue")
async def list_review_queue(
    project_id: Optional[str] = None,
    status: str = "pending",
    source_type: Optional[str] = None,     # 'generated' | 'original' | None=全部
    upload_batch_id: Optional[str] = None,  # 只看某一批
    offset: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    """List images by review_status. Defaults to pending; pass status=rejected
    to inspect what's been hidden from matching, status=approved for audit.

    治理策略第一期:审核队列不再只收 AI 图 —— 手动上传现在也默认进暂存(pending),
    同样要在这里审。可用 source_type / upload_batch_id 过滤。"""
    if status not in {"pending", "approved", "rejected", "skipped"}:
        raise HTTPException(400, "invalid status")
    limit = max(1, min(int(limit), 200))

    q = select(Image).where(Image.review_status == status)
    if project_id:
        q = q.where(Image.project_id == project_id)
    if source_type:
        q = q.where(Image.source_type == source_type)
    if upload_batch_id:
        q = q.where(Image.upload_batch_id == upload_batch_id)

    total = await db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = await db.execute(
        q.order_by(Image.created_at.desc()).offset(offset).limit(limit)
    )
    items = rows.scalars().all()

    # 打标完整度(审核-打标配合):一次性算出本页每张图缺哪些必填维度。
    from sidecar.db.models import Tag
    from sidecar.engines.tag_completeness import required_dimensions
    required = required_dimensions()
    missing_by_img: dict[str, list[str]] = {}
    if required and items:
        ids = [im.id for im in items]
        trows = (await db.execute(
            select(Tag.image_id, Tag.dimension)
            .where(Tag.image_id.in_(ids))
            .where(Tag.dimension.in_(required))
        )).all()
        present: dict[str, set] = {}
        for iid, dim in trows:
            present.setdefault(iid, set()).add(dim)
        for iid in ids:
            missing_by_img[iid] = [d for d in required if d not in present.get(iid, set())]

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "required_dims": required,
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
                "reviewed_by": img.reviewed_by,
                "source_type": img.source_type,
                "source_channel": img.source_channel,
                "upload_batch_id": img.upload_batch_id,
                "uploaded_by": img.uploaded_by,
                "tag_status": img.tag_status,
                # 打标门禁:缺的必填维度 + 是否打全(前端据此提示"通过后不会上OSS")
                "missing_dims": missing_by_img.get(img.id, []),
                "tags_complete": len(missing_by_img.get(img.id, [])) == 0,
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
    """Pending count for sidebar badge + summary stats for the queue page.

    治理策略第一期:统计所有来源(含手动上传的暂存图),不再只数 AI 图。"""
    base = select(Image)
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


async def _apply_decision(
    db: AsyncSession, image_ids: list[str], decision: str, reviewer_id: Optional[str],
) -> int:
    """把审核结论应用到一批**待审核**图，并触发上云副作用。返回实际更新数。

    治理策略(审核 ≠ UGC 上架):
      - 通过(approved) → 图进正式素材库 → 推 OSS 文件 + 推云端元数据,
        供 UGC 后台同步并【自行选择上架】。**不自动动 is_listed**——是否被 UGC
        调用由 UGC 后台的上架决定,不是审核这一步。
      - 拒绝(rejected) → 移出正式库(is_listed=False)。
      - 跳过(skipped)  → 只记审核态,保持暂存,下次仍在队列。

    API 只消费 review_status='pending' 的记录，避免陈旧的前端选中状态或误调用
    把已经通过、已拒绝的图再次改写，进而意外触发 OSS 发布。
    """
    if not image_ids:
        return 0
    now = datetime.utcnow()
    pending_ids = [
        row[0] for row in (await db.execute(
            select(Image.id)
            .where(Image.id.in_(image_ids))
            .where(Image.review_status == "pending")
        )).all()
    ]
    if not pending_ids:
        return 0

    values: dict = {
        "review_status": decision,
        "reviewed_at": now,
        "reviewed_by": reviewer_id,
    }
    if decision == "rejected":
        values["is_listed"] = False  # 退回顺带移出匹配池,但通过不自动上架

    result = await db.execute(
        update(Image).where(Image.id.in_(pending_ids)).values(**values)
    )
    await db.commit()
    updated = result.rowcount or 0

    try:
        if decision == "approved":
            # 审核通过 = 可上 OSS(门禁已改为 review_status=='approved')+ 推云端
            from sidecar.engines.oss_sync import enqueue_image_sync
            from sidecar.scheduler.cloud_sync_worker import enqueue_image_upsert
            for iid in pending_ids:
                await enqueue_image_sync(iid)
                await enqueue_image_upsert(iid)
    except Exception as e:
        logger.debug("review decision side-effect failed: %s", e)

    return updated


@router.post("/decide")
async def decide(body: DecideBody, request: Request, db: AsyncSession = Depends(get_db)):
    """Batch decision endpoint. Returns the count actually updated."""
    if body.decision not in VALID_DECISIONS:
        raise HTTPException(400, f"decision must be one of {VALID_DECISIONS}")
    if not body.image_ids:
        return {"ok": True, "updated": 0}
    updated = await _apply_decision(
        db, body.image_ids, body.decision, _current_user_id(request)
    )
    return {"ok": True, "updated": updated, "decision": body.decision}


# ── 上传批次(来源追溯 · 治理策略第一期)──


@router.get("/batches")
async def list_batches(
    project_id: Optional[str] = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    """列出上传批次 + 每批的 待审/已通过/已拒 计数,供审核页按批次分组。"""
    limit = max(1, min(int(limit), 200))
    q = select(UploadBatch)
    if project_id:
        q = q.where(UploadBatch.project_id == project_id)
    batches = (await db.execute(
        q.order_by(UploadBatch.created_at.desc()).limit(limit)
    )).scalars().all()

    # 一次性把这些批次的图按 (批次, 审核态) 聚合计数
    ids = [b.id for b in batches]
    counts: dict[str, dict[str, int]] = {}
    if ids:
        rows = await db.execute(
            select(Image.upload_batch_id, Image.review_status, func.count(Image.id))
            .where(Image.upload_batch_id.in_(ids))
            .group_by(Image.upload_batch_id, Image.review_status)
        )
        for bid, st, cnt in rows.all():
            counts.setdefault(bid, {})[st] = cnt

    return {
        "items": [
            {
                "id": b.id,
                "batch_no": b.batch_no,
                "project_id": b.project_id,
                "source_channel": b.source_channel,
                "uploaded_by": b.uploaded_by,
                "uploaded_by_name": b.uploaded_by_name,
                "task_id": b.task_id,
                "note": b.note,
                "total": b.total,
                "created_at": b.created_at.isoformat() if b.created_at else None,
                "counts": counts.get(b.id, {}),
            }
            for b in batches
        ]
    }


class BatchDecideBody(BaseModel):
    upload_batch_id: str
    decision: str   # 'approved' | 'rejected' | 'skipped'


@router.post("/batch-decide")
async def batch_decide(body: BatchDecideBody, request: Request, db: AsyncSession = Depends(get_db)):
    """整批审核:通过 / 退回(拒绝) / 跳过 一整个上传批次。"""
    if body.decision not in VALID_DECISIONS:
        raise HTTPException(400, f"decision must be one of {VALID_DECISIONS}")
    # 整批操作也只能处理仍在待审核队列里的图；已经通过/退回的图不被回写。
    ids = [
        r[0] for r in (await db.execute(
            select(Image.id)
            .where(Image.upload_batch_id == body.upload_batch_id)
            .where(Image.review_status == "pending")
        )).all()
    ]
    if not ids:
        return {"ok": True, "updated": 0}
    updated = await _apply_decision(db, ids, body.decision, _current_user_id(request))
    return {"ok": True, "updated": updated, "decision": body.decision, "batch": body.upload_batch_id}
