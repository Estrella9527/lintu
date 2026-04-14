from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.config import THUMBNAILS_DIR
from sidecar.db.models import Image, Tag
from sidecar.db.session import get_db
from sidecar.engines.thumbnail import (
    THUMBNAIL_SIZES,
    generate_thumbnail,
    get_thumbnail_path,
)

router = APIRouter()


# ── List images with multi-dimensional filtering ──


@router.get("")
async def list_images(
    project_id: str,
    offset: int = 0,
    limit: int = 120,
    search: Optional[str] = None,
    status: Optional[str] = None,
    scene: Optional[List[str]] = Query(None),
    season: Optional[List[str]] = Query(None),
    weather: Optional[List[str]] = Query(None),
    angle: Optional[List[str]] = Query(None),
    people: Optional[List[str]] = Query(None),
    source_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    query = select(Image).where(Image.project_id == project_id)

    if search:
        query = query.where(Image.file_name.ilike(f"%{search}%"))
    if source_type:
        if source_type == "generated":
            query = query.where(Image.source_type == "generated")
        elif source_type == "original":
            query = query.where(Image.source_type == "original")
        else:
            # Filter by generation type (crop, upscale, etc.) via filename pattern
            query = query.where(Image.source_type == "generated")
            query = query.where(Image.file_name.ilike(f"%{source_type}%"))
    if status:
        query = query.where(Image.quality_status == status)

    # Tag-based filtering: AND across dimensions, OR within a dimension
    tag_filters = [
        ("scene", scene),
        ("season", season),
        ("weather", weather),
        ("angle", angle),
        ("people", people),
    ]
    for dim, values in tag_filters:
        if values:
            subq = select(Tag.image_id).where(Tag.dimension == dim, Tag.value.in_(values))
            query = query.where(Image.id.in_(subq))

    # Count total before pagination
    count_query = select(func.count()).select_from(query.subquery())
    total = await db.scalar(count_query) or 0

    # Fetch page
    result = await db.execute(
        query.order_by(Image.created_at.desc()).offset(offset).limit(limit)
    )
    items = result.scalars().all()

    return {
        "items": [_image_to_dict(img) for img in items],
        "total": total,
    }


# ── Single image detail ──


@router.get("/{image_id}")
async def get_image(image_id: str, db: AsyncSession = Depends(get_db)):
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    # Eager load tags
    result = await db.execute(select(Tag).where(Tag.image_id == image_id))
    tags = result.scalars().all()
    d = _image_to_dict(img)
    d["tags"] = [
        {"id": t.id, "dimension": t.dimension, "value": t.value,
         "confidence": t.confidence, "source": t.source}
        for t in tags
    ]
    return d


# ── Thumbnail endpoint ──


@router.get("/{image_id}/thumbnail")
async def get_thumbnail(
    image_id: str,
    size: int = 300,
    db: AsyncSession = Depends(get_db),
):
    if size not in THUMBNAIL_SIZES:
        raise HTTPException(400, f"Invalid size. Allowed: {THUMBNAIL_SIZES}")

    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")

    thumb_path = get_thumbnail_path(image_id, size, THUMBNAILS_DIR)

    if not thumb_path.exists():
        source = Path(img.file_path)
        if not source.exists():
            raise HTTPException(404, "Source image file not found")
        generate_thumbnail(str(source), thumb_path, size)

    return FileResponse(
        thumb_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── Update tags ──


class UpdateTagsBody(BaseModel):
    tags: dict  # {dimension: [values]} or {dimension: value}


@router.put("/{image_id}/tags")
async def update_tags(
    image_id: str,
    body: UpdateTagsBody,
    db: AsyncSession = Depends(get_db),
):
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")

    # Delete existing AI tags, keep manual ones
    existing = await db.execute(
        select(Tag).where(Tag.image_id == image_id, Tag.source == "ai")
    )
    for tag in existing.scalars().all():
        await db.delete(tag)

    # Insert new tags
    for dimension, value in body.tags.items():
        if isinstance(value, list):
            for v in value:
                db.add(Tag(image_id=image_id, dimension=dimension, value=v, source="manual"))
        elif isinstance(value, str):
            db.add(Tag(image_id=image_id, dimension=dimension, value=value, source="manual"))

    img.tag_status = "manual"
    await db.commit()
    return {"ok": True}


# ── Download original ──


@router.get("/{image_id}/download")
async def download_image(image_id: str, db: AsyncSession = Depends(get_db)):
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    source = Path(img.file_path)
    if not source.exists():
        raise HTTPException(404, "Source file not found")
    return FileResponse(
        source,
        filename=img.file_name,
        headers={"Cache-Control": "no-cache"},
    )


# ── Delete ──


@router.delete("/{image_id}")
async def delete_image(image_id: str, db: AsyncSession = Depends(get_db)):
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    # Delete tags
    tags = await db.execute(select(Tag).where(Tag.image_id == image_id))
    for tag in tags.scalars().all():
        await db.delete(tag)
    await db.delete(img)
    await db.commit()
    return {"ok": True}


# ── Batch operations ──


class BatchActionBody(BaseModel):
    image_ids: list[str]


@router.post("/batch/delete")
async def batch_delete(body: BatchActionBody, db: AsyncSession = Depends(get_db)):
    deleted = 0
    for img_id in body.image_ids:
        img = await db.get(Image, img_id)
        if img:
            tags = await db.execute(select(Tag).where(Tag.image_id == img_id))
            for tag in tags.scalars().all():
                await db.delete(tag)
            await db.delete(img)
            deleted += 1
    await db.commit()
    return {"ok": True, "deleted": deleted}


@router.post("/batch/update-status")
async def batch_update_status(
    body: BatchActionBody,
    status: str = "passed",
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import update as sql_update
    await db.execute(
        sql_update(Image)
        .where(Image.id.in_(body.image_ids))
        .values(quality_status=status)
    )
    await db.commit()
    return {"ok": True}


def _image_to_dict(img: Image) -> dict:
    return {
        "id": img.id,
        "project_id": img.project_id,
        "file_path": img.file_path,
        "file_name": img.file_name,
        "file_size_kb": img.file_size_kb,
        "width": img.width,
        "height": img.height,
        "blur_score": img.blur_score,
        "brightness": img.brightness,
        "quality_status": img.quality_status,
        "reject_reason": img.reject_reason,
        "is_kept": img.is_kept,
        "tag_status": img.tag_status,
        "description": img.description,
        "source_type": img.source_type,
        "created_at": img.created_at.isoformat() if img.created_at else None,
    }
