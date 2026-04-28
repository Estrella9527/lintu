from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete as sql_delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, Project, Tag
from sidecar.db.session import get_db

router = APIRouter()


class CreateProjectBody(BaseModel):
    name: str
    originals_path: str
    workspace_path: str
    color: Optional[str] = None


class UpdateProjectBody(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None


@router.post("")
async def create_project(body: CreateProjectBody, db: AsyncSession = Depends(get_db)):
    project = Project(
        name=body.name,
        originals_path=body.originals_path,
        workspace_path=body.workspace_path,
        color=body.color,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    await _enqueue_cloud_upsert(project.id)
    return _project_to_dict(project)


async def _enqueue_cloud_upsert(project_id: str) -> None:
    try:
        from sidecar.scheduler.cloud_sync_worker import enqueue_project_upsert
        await enqueue_project_upsert(project_id)
    except Exception:
        pass


@router.get("")
async def list_projects(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Project).order_by(Project.created_at.desc()))
    return [_project_to_dict(p) for p in result.scalars().all()]


@router.get("/{project_id}")
async def get_project(project_id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return _project_to_dict(project)


@router.patch("/{project_id}")
async def update_project(
    project_id: str,
    body: UpdateProjectBody,
    db: AsyncSession = Depends(get_db),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "Project name cannot be empty")
        project.name = name
    if body.color is not None:
        # Empty string clears the color back to default.
        project.color = body.color.strip() or None
    await db.commit()
    await db.refresh(project)
    await _enqueue_cloud_upsert(project.id)
    return _project_to_dict(project)


@router.delete("/{project_id}")
async def delete_project(project_id: str, db: AsyncSession = Depends(get_db)):
    """Hard-delete a project along with its images + tags from the database.
    On-disk image files (originals + workspace) are NOT touched — the user
    can clean those up separately if they want.
    """
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    # Tags FK to Image, so drop them first. Chunk to keep IN-clauses sane.
    image_ids = [
        row[0] for row in (await db.execute(
            select(Image.id).where(Image.project_id == project_id)
        )).all()
    ]
    deleted_tags = 0
    deleted_images = 0
    CHUNK = 500
    for i in range(0, len(image_ids), CHUNK):
        chunk = image_ids[i:i + CHUNK]
        await db.execute(sql_delete(Tag).where(Tag.image_id.in_(chunk)))
        result = await db.execute(sql_delete(Image).where(Image.id.in_(chunk)))
        deleted_images += result.rowcount or 0
        deleted_tags += 1  # rowcount on tags is per-batch, kept loose
    await db.delete(project)
    await db.commit()
    try:
        from sidecar.scheduler.cloud_sync_worker import enqueue_project_delete, enqueue_image_delete
        for img_id in image_ids:
            await enqueue_image_delete(img_id)
        await enqueue_project_delete(project_id)
    except Exception:
        pass
    return {
        "ok": True,
        "deleted_images": deleted_images,
        "image_files_kept_on_disk": True,
    }


@router.get("/{project_id}/stats")
async def project_stats(project_id: str, db: AsyncSession = Depends(get_db)):
    """Lightweight counts used by the delete-confirmation dialog so the
    user knows what they're about to nuke."""
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    image_count = await db.scalar(
        select(func.count(Image.id)).where(Image.project_id == project_id)
    ) or 0
    return {"project_id": project_id, "image_count": int(image_count)}


def _project_to_dict(p: Project) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "originals_path": p.originals_path,
        "workspace_path": p.workspace_path,
        "color": p.color,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }
