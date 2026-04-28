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
from sidecar.engines.image_utils import effective_file_path
from sidecar.engines.thumbnail import (
    THUMBNAIL_SIZES,
    generate_thumbnail,
    get_thumbnail_path,
)

router = APIRouter()


# ── List images with multi-dimensional filtering ──


def _apply_image_filters(
    query,
    *,
    search: Optional[str] = None,
    status: Optional[str] = None,
    scene: Optional[List[str]] = None,
    season: Optional[List[str]] = None,
    weather: Optional[List[str]] = None,
    angle: Optional[List[str]] = None,
    people: Optional[List[str]] = None,
    facility: Optional[List[str]] = None,
    usage: Optional[List[str]] = None,
    style: Optional[List[str]] = None,
    mood: Optional[List[str]] = None,
    palette: Optional[List[str]] = None,
    theme: Optional[List[str]] = None,
    composition: Optional[List[str]] = None,
    source_type: Optional[str] = None,
    folder: Optional[str] = None,
    folder_prefix: Optional[str] = None,
    prompt_id: Optional[str] = None,
    parent_id: Optional[str] = None,
):
    """Shared filter pipeline so list_images and list_image_ids stay in sync.

    Cross-dimension semantics: AND (must match every filtered dimension).
    Within-dimension semantics: OR (any value in the list matches).
    """
    if search:
        query = query.where(Image.file_name.ilike(f"%{search}%"))
    if folder is not None:
        query = query.where(Image.relative_dir == folder)
    elif folder_prefix:
        query = query.where(
            (Image.relative_dir == folder_prefix) |
            Image.relative_dir.like(f"{folder_prefix}/%")
        )
    if source_type:
        if source_type == "generated":
            query = query.where(Image.source_type == "generated")
        elif source_type == "original":
            query = query.where(Image.source_type == "original")
        else:
            query = query.where(Image.source_type == "generated")
            query = query.where(Image.file_name.ilike(f"%{source_type}%"))
    if status:
        query = query.where(Image.quality_status == status)

    # All 12 tag dimensions — the 5 new soft-tag ones (style/mood/palette/
    # theme/composition) are essential for "browse by visual style".
    tag_filters = [
        ("scene", scene), ("season", season), ("weather", weather),
        ("angle", angle), ("people", people),
        ("facility", facility), ("usage", usage),
        ("style", style), ("mood", mood), ("palette", palette),
        ("theme", theme), ("composition", composition),
    ]
    for dim, values in tag_filters:
        if values:
            subq = select(Tag.image_id).where(Tag.dimension == dim, Tag.value.in_(values))
            query = query.where(Image.id.in_(subq))

    # Filter by which prompt generated the image. Stored in
    # generation_metadata JSON column. Uses SQLite json_extract — for
    # PostgreSQL we'd switch to ->> 'prompt_id'.
    if prompt_id:
        query = query.where(
            func.json_extract(Image.generation_metadata, "$.prompt_id") == prompt_id
        )
    if parent_id:
        query = query.where(Image.parent_id == parent_id)
    return query


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
    facility: Optional[List[str]] = Query(None),
    usage: Optional[List[str]] = Query(None),
    style: Optional[List[str]] = Query(None),
    mood: Optional[List[str]] = Query(None),
    palette: Optional[List[str]] = Query(None),
    theme: Optional[List[str]] = Query(None),
    composition: Optional[List[str]] = Query(None),
    source_type: Optional[str] = None,
    folder: Optional[str] = None,
    folder_prefix: Optional[str] = None,
    prompt_id: Optional[str] = None,
    parent_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    base = select(Image).where(Image.project_id == project_id)
    query = _apply_image_filters(
        base, search=search, status=status, scene=scene, season=season,
        weather=weather, angle=angle, people=people, facility=facility,
        usage=usage, style=style, mood=mood, palette=palette, theme=theme,
        composition=composition, source_type=source_type,
        folder=folder, folder_prefix=folder_prefix, prompt_id=prompt_id,
        parent_id=parent_id,
    )
    total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
    result = await db.execute(
        query.order_by(Image.created_at.desc()).offset(offset).limit(limit)
    )
    items = result.scalars().all()
    return {"items": [_image_to_dict(img) for img in items], "total": total}


@router.get("/ids")
async def list_image_ids(
    project_id: str,
    search: Optional[str] = None,
    status: Optional[str] = None,
    scene: Optional[List[str]] = Query(None),
    season: Optional[List[str]] = Query(None),
    weather: Optional[List[str]] = Query(None),
    angle: Optional[List[str]] = Query(None),
    people: Optional[List[str]] = Query(None),
    facility: Optional[List[str]] = Query(None),
    usage: Optional[List[str]] = Query(None),
    style: Optional[List[str]] = Query(None),
    mood: Optional[List[str]] = Query(None),
    palette: Optional[List[str]] = Query(None),
    theme: Optional[List[str]] = Query(None),
    composition: Optional[List[str]] = Query(None),
    source_type: Optional[str] = None,
    folder: Optional[str] = None,
    folder_prefix: Optional[str] = None,
    prompt_id: Optional[str] = None,
    parent_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Return every image id matching the same filters used by list_images.

    Powers the asset-library "select all matching filter" affordance, which
    can target tens of thousands of images for a single bulk re-process job.
    """
    base = select(Image.id).where(Image.project_id == project_id)
    query = _apply_image_filters(
        base, search=search, status=status, scene=scene, season=season,
        weather=weather, angle=angle, people=people, facility=facility,
        usage=usage, style=style, mood=mood, palette=palette, theme=theme,
        composition=composition, source_type=source_type,
        folder=folder, folder_prefix=folder_prefix, prompt_id=prompt_id,
        parent_id=parent_id,
    )
    rows = await db.execute(query.order_by(Image.created_at.desc()))
    ids = [r[0] for r in rows.all()]
    return {"ids": ids, "count": len(ids)}


# ── Single image detail ──


# ── Folder tree (Phase 2) ──


@router.get("/folders")
async def list_folders(
    project_id: str,
    source_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Return every distinct relative_dir with its image count.

    The frontend expands this flat list into a tree. Empty relative_dir is
    reported as the root (label: "/", value: "").
    """
    q = (
        select(Image.relative_dir, func.count(Image.id).label("count"))
        .where(Image.project_id == project_id)
        .group_by(Image.relative_dir)
    )
    if source_type:
        q = q.where(Image.source_type == source_type)
    rows = await db.execute(q)
    return [
        {"folder": (r[0] or ""), "count": r[1]}
        for r in rows.all()
    ]


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
    source = Path(effective_file_path(img))

    # Regenerate if: thumb missing, or source file has been rewritten since
    # the thumb was generated (e.g., after orient corrected the image).
    needs_regenerate = not thumb_path.exists()
    if not needs_regenerate:
        try:
            if source.exists() and source.stat().st_mtime > thumb_path.stat().st_mtime:
                needs_regenerate = True
        except OSError:
            needs_regenerate = True

    if needs_regenerate:
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


# ── Full-resolution streaming (for lightbox / inline <img src>) ──

_EXT_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff", ".tiff": "image/tiff",
    ".heic": "image/heic", ".heif": "image/heif",
}


@router.get("/{image_id}/file")
async def stream_image_file(image_id: str, db: AsyncSession = Depends(get_db)):
    """Stream the effective full-resolution image bytes (rotated derivative
    when present, else original). NO re-encoding. Used by the lightbox so
    users see exactly what the AI generated / what they uploaded."""
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    source = Path(effective_file_path(img))
    if not source.exists():
        raise HTTPException(404, "Source file not found")
    mime = _EXT_MIME.get(source.suffix.lower(), "application/octet-stream")
    return FileResponse(
        source,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ── Download original ──


@router.get("/{image_id}/download")
async def download_image(image_id: str, db: AsyncSession = Depends(get_db)):
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    # Downloads should hand the user the raw original bytes they uploaded —
    # NOT any rotated derivative. This is the "I want the exact file I
    # imported" escape hatch.
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
    """Bulk delete images + their tags. Replaces an O(n) per-row ORM loop
    with chunked bulk DELETEs, so removing 3,000+ rows now takes <1s
    instead of timing out.

    Chunk size 500 stays well below SQLite's default IN-clause variable
    limit (~999) and keeps each round-trip cheap.
    """
    if not body.image_ids:
        return {"ok": True, "deleted": 0}

    from sqlalchemy import delete as sql_delete

    CHUNK = 500
    deleted = 0
    for i in range(0, len(body.image_ids), CHUNK):
        chunk = body.image_ids[i:i + CHUNK]
        # Tags first to satisfy the FK if PRAGMA foreign_keys=ON.
        await db.execute(sql_delete(Tag).where(Tag.image_id.in_(chunk)))
        result = await db.execute(sql_delete(Image).where(Image.id.in_(chunk)))
        deleted += result.rowcount or 0
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
        "relative_dir": img.relative_dir or "",
        "orient_status": img.orient_status or "none",
        "rotated_file_path": img.rotated_file_path,
        "parent_id": img.parent_id,
        "generation_metadata": img.generation_metadata,
        "created_at": img.created_at.isoformat() if img.created_at else None,
        "updated_at": img.updated_at.isoformat() if img.updated_at else None,
    }
