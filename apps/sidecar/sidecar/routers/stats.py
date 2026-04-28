from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, Tag, Task
from sidecar.db.session import get_db

router = APIRouter()


@router.get("/recent-images")
async def recent_images_count(
    project_id: str = "",
    hours: int = 24,
    db: AsyncSession = Depends(get_db),
):
    """How many generated images landed in the last N hours. Powers the
    sidebar 资产库 "新内容" badge."""
    hours = max(1, min(int(hours), 24 * 30))
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    q = select(func.count(Image.id)).where(
        Image.created_at >= cutoff,
        Image.source_type == "generated",
    )
    if project_id:
        q = q.where(Image.project_id == project_id)
    n = await db.scalar(q) or 0
    return {"hours": hours, "generated": int(n)}


@router.get("/dashboard")
async def dashboard_stats(project_id: str = "", db: AsyncSession = Depends(get_db)):
    # Base filter
    img_q = select(Image)
    if project_id:
        img_q = img_q.where(Image.project_id == project_id)

    total = await db.scalar(select(func.count()).select_from(img_q.subquery())) or 0
    passed = await db.scalar(
        select(func.count()).select_from(
            img_q.where(Image.quality_status == "passed").subquery()
        )
    ) or 0
    rejected = await db.scalar(
        select(func.count()).select_from(
            img_q.where(Image.quality_status == "rejected").subquery()
        )
    ) or 0
    tagged = await db.scalar(
        select(func.count()).select_from(
            img_q.where(Image.tag_status == "tagged").subquery()
        )
    ) or 0
    derivatives = await db.scalar(
        select(func.count()).select_from(
            img_q.where(Image.source_type == "generated").subquery()
        )
    ) or 0

    quality_pass_rate = passed / total if total > 0 else 0
    tag_progress = tagged / passed if passed > 0 else 0

    # Running tasks
    task_q = select(Task)
    if project_id:
        task_q = task_q.where(Task.project_id == project_id)

    running_result = await db.execute(
        task_q.where(Task.status == "running").order_by(Task.created_at.desc())
    )
    running_tasks = [_task_dict(t) for t in running_result.scalars().all()]

    recent_result = await db.execute(
        task_q.order_by(Task.created_at.desc()).limit(5)
    )
    recent_tasks = [_task_dict(t) for t in recent_result.scalars().all()]

    # Tag distribution — top 20
    tag_dist_q = (
        select(Tag.dimension, Tag.value, func.count(Tag.id).label("count"))
        .group_by(Tag.dimension, Tag.value)
        .order_by(desc("count"))
        .limit(20)
    )
    if project_id:
        tag_dist_q = tag_dist_q.join(Image, Tag.image_id == Image.id).where(
            Image.project_id == project_id
        )
    tag_dist_result = await db.execute(tag_dist_q)
    tag_distribution = [
        {"dimension": row[0], "value": row[1], "count": row[2]}
        for row in tag_dist_result
    ]

    return {
        "counts": {
            "total": total,
            "passed": passed,
            "rejected": rejected,
            "tagged": tagged,
            "derivatives": derivatives,
        },
        "rates": {
            "quality_pass": round(quality_pass_rate, 4),
            "tag_progress": round(tag_progress, 4),
        },
        "running_tasks": running_tasks,
        "recent_tasks": recent_tasks,
        "tag_distribution": tag_distribution,
    }


@router.get("/embed-coverage")
async def embed_coverage(project_id: str = "", db: AsyncSession = Depends(get_db)):
    """Embedding coverage by model tag — used by Pipeline → Embed step to show
    "needs rebuild?" status when image dim doesn't match the configured
    text→image search model.
    """
    base = select(Image)
    if project_id:
        base = base.where(Image.project_id == project_id)

    total = await db.scalar(select(func.count()).select_from(base.subquery())) or 0
    embedded = await db.scalar(
        select(func.count()).select_from(
            base.where(Image.embedding.is_not(None)).where(Image.embedding != "").subquery()
        )
    ) or 0

    # Group by embedding_model so the UI can detect mixed-dim libraries.
    by_model_q = (
        select(Image.embedding_model, func.count(Image.id))
        .where(Image.embedding.is_not(None))
        .where(Image.embedding != "")
        .group_by(Image.embedding_model)
    )
    if project_id:
        by_model_q = by_model_q.where(Image.project_id == project_id)
    by_model_rows = await db.execute(by_model_q)
    by_model = [{"model": row[0] or "(unknown)", "count": int(row[1])} for row in by_model_rows.all()]

    # Compare with the currently-configured embedding provider's expected tag.
    from sidecar.engines.clip_embed import _resolve_api_provider, EMBEDDING_TAG_LOCAL
    target = _resolve_api_provider()
    expected_tag = target[1] if target else EMBEDDING_TAG_LOCAL

    aligned = sum(b["count"] for b in by_model if b["model"] == expected_tag)
    misaligned = sum(b["count"] for b in by_model if b["model"] != expected_tag and b["model"] != "(unknown)")

    return {
        "total": total,
        "embedded": embedded,
        "missing": max(0, total - embedded),
        "by_model": by_model,
        "expected_tag": expected_tag,
        "aligned": aligned,
        "misaligned": misaligned,
        "fully_aligned": misaligned == 0 and aligned == total,
    }


def _task_dict(t: Task) -> dict:
    return {
        "id": t.id,
        "type": t.type,
        "status": t.status,
        "total": t.total,
        "processed": t.processed,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }
