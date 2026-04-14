"""Open API: public endpoints for external systems to access images."""

from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, Tag
from sidecar.db.session import get_db
from sidecar.engines.thumbnail import get_thumbnail_path, generate_thumbnail, THUMBNAIL_SIZES
from sidecar.config import THUMBNAILS_DIR

router = APIRouter()


@router.get("/images")
async def api_list_images(
    project_id: Optional[str] = None,
    source_type: Optional[str] = None,
    scene: Optional[List[str]] = Query(None),
    season: Optional[List[str]] = Query(None),
    offset: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    """List images with filters. Returns JSON with CDN-ready URLs."""
    query = select(Image).where(Image.quality_status == "passed", Image.is_kept == True)

    if project_id:
        query = query.where(Image.project_id == project_id)
    if source_type:
        query = query.where(Image.source_type == source_type)

    for dim, values in [("scene", scene), ("season", season)]:
        if values:
            subq = select(Tag.image_id).where(Tag.dimension == dim, Tag.value.in_(values))
            query = query.where(Image.id.in_(subq))

    total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
    result = await db.execute(query.order_by(Image.created_at.desc()).offset(offset).limit(limit))
    items = result.scalars().all()

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": [
            {
                "id": img.id,
                "file_name": img.file_name,
                "width": img.width,
                "height": img.height,
                "source_type": img.source_type,
                "description": img.description,
                "thumbnail_url": f"/open-api/images/{img.id}/file?size=300",
                "original_url": f"/open-api/images/{img.id}/file",
            }
            for img in items
        ],
    }


@router.get("/images/{image_id}")
async def api_get_image(image_id: str, db: AsyncSession = Depends(get_db)):
    """Get image metadata + tags."""
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")

    tags_result = await db.execute(select(Tag).where(Tag.image_id == image_id))
    tags = {}
    for t in tags_result.scalars().all():
        if t.dimension not in tags:
            tags[t.dimension] = []
        tags[t.dimension].append(t.value)

    return {
        "id": img.id,
        "file_name": img.file_name,
        "width": img.width,
        "height": img.height,
        "source_type": img.source_type,
        "description": img.description,
        "tags": tags,
        "thumbnail_url": f"/open-api/images/{img.id}/file?size=300",
        "original_url": f"/open-api/images/{img.id}/file",
    }


@router.get("/images/{image_id}/file")
async def api_get_image_file(
    image_id: str,
    size: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
):
    """Serve image file. Optional size param for thumbnail (128/300/800)."""
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")

    if size and size in THUMBNAIL_SIZES:
        thumb_path = get_thumbnail_path(image_id, size, THUMBNAILS_DIR)
        if not thumb_path.exists():
            source = Path(img.file_path)
            if not source.exists():
                raise HTTPException(404, "Source file not found")
            generate_thumbnail(str(source), thumb_path, size)
        return FileResponse(thumb_path, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=86400"})

    source = Path(img.file_path)
    if not source.exists():
        raise HTTPException(404, "Source file not found")
    return FileResponse(source, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=3600"})


@router.get("/tags")
async def api_list_tags(
    project_id: Optional[str] = None,
    dimension: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """List tag distribution for a project."""
    query = (
        select(Tag.dimension, Tag.value, func.count(Tag.id).label("count"))
        .group_by(Tag.dimension, Tag.value)
        .order_by(Tag.dimension, func.count(Tag.id).desc())
    )
    if project_id:
        query = query.join(Image, Tag.image_id == Image.id).where(Image.project_id == project_id)
    if dimension:
        query = query.where(Tag.dimension == dimension)

    result = await db.execute(query)
    return [
        {"dimension": row[0], "value": row[1], "count": row[2]}
        for row in result
    ]


@router.get("/stats")
async def api_stats(project_id: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    """Quick stats for external dashboards."""
    q = select(Image)
    if project_id:
        q = q.where(Image.project_id == project_id)

    total = await db.scalar(select(func.count()).select_from(q.subquery())) or 0
    passed = await db.scalar(select(func.count()).select_from(
        q.where(Image.quality_status == "passed").subquery()
    )) or 0
    generated = await db.scalar(select(func.count()).select_from(
        q.where(Image.source_type == "generated").subquery()
    )) or 0
    tagged = await db.scalar(select(func.count()).select_from(
        q.where(Image.tag_status == "tagged").subquery()
    )) or 0

    return {
        "total_images": total,
        "passed": passed,
        "generated": generated,
        "tagged": tagged,
    }
