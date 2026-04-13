from fastapi import APIRouter, Depends
from sqlalchemy import func, select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, Tag, Task
from sidecar.db.session import get_db

router = APIRouter()


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


def _task_dict(t: Task) -> dict:
    return {
        "id": t.id,
        "type": t.type,
        "status": t.status,
        "total": t.total,
        "processed": t.processed,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }
