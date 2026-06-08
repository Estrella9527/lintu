import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from PIL import Image as PILImage
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.config import THUMBNAILS_DIR
from sidecar.db.models import Image, Project, Tag
from sidecar.db.session import get_db
from sidecar.engines.image_utils import compute_perceptual_hashes, effective_file_path
from sidecar.engines.oss_sync import enqueue_image_sync
from sidecar.engines.thumbnail import (
    THUMBNAIL_SIZES,
    generate_thumbnail,
    get_thumbnail_path,
)

logger = logging.getLogger(__name__)

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
    # generation_metadata JSON column. json_field() picks the right SQL for
    # the active backend (SQLite json_extract / PG ->>).
    if prompt_id:
        from sidecar.db.json_ops import json_field
        query = query.where(json_field(Image.generation_metadata, "prompt_id") == prompt_id)
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


class ImagePatchBody(BaseModel):
    """Lightweight PATCH for single-image field updates.

    review_status — 推到审核队列 / 改审核态。
    is_listed     — 上架 / 下架(决定是否进 UGC 匹配候选池,与审核正交)。"""
    review_status: Optional[str] = None
    is_listed: Optional[bool] = None


@router.patch("/{image_id}")
async def patch_image(
    image_id: str,
    body: ImagePatchBody,
    db: AsyncSession = Depends(get_db),
):
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    from datetime import datetime as _dt
    if body.review_status is not None:
        if body.review_status not in {"pending", "approved", "rejected", "skipped"}:
            raise HTTPException(400, "invalid review_status")
        img.review_status = body.review_status
        img.reviewed_at = _dt.utcnow() if body.review_status != "pending" else None
    if body.is_listed is not None:
        img.is_listed = body.is_listed
        img.listed_at = _dt.utcnow() if body.is_listed else None
    await db.commit()
    return {"ok": True, "id": image_id, "review_status": img.review_status,
            "is_listed": img.is_listed}


class ListingBody(BaseModel):
    image_ids: list[str]
    is_listed: bool


@router.post("/batch/listing")
async def batch_set_listing(body: ListingBody, db: AsyncSession = Depends(get_db)):
    """批量上架 / 下架。is_listed=True 上架,False 下架。"""
    if not body.image_ids:
        return {"ok": True, "updated": 0}
    from datetime import datetime as _dt
    rows = (await db.execute(
        select(Image).where(Image.id.in_(body.image_ids))
    )).scalars().all()
    now = _dt.utcnow() if body.is_listed else None
    for img in rows:
        img.is_listed = body.is_listed
        img.listed_at = now
    await db.commit()
    return {"ok": True, "updated": len(rows), "is_listed": body.is_listed}


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
    try:
        from sidecar.scheduler.cloud_sync_worker import enqueue_image_delete
        await enqueue_image_delete(image_id)
    except Exception:
        pass
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
    # Mirror the deletes to the cloud so UGC can't match orphan rows.
    try:
        from sidecar.scheduler.cloud_sync_worker import enqueue_image_delete
        for img_id in body.image_ids:
            await enqueue_image_delete(img_id)
    except Exception:
        pass
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


_UPLOAD_ALLOWED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp", ".tiff", ".tif"}
_UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024  # 50 MB / file
_UPLOAD_MAX_FILES_PER_REQUEST = 30


def _safe_ext(filename: str) -> str:
    """Lowercase the suffix and reject anything outside the allowlist.

    Filename comes straight from the browser/clipboard so it can't be trusted —
    we never reuse it on disk verbatim. We only consult the suffix to pick the
    PIL decoder and the on-disk extension.
    """
    suf = Path(filename or "").suffix.lower()
    if suf not in _UPLOAD_ALLOWED_EXTS:
        # Clipboard pastes often arrive as image/png with filename "image.png"
        # or no filename at all; that's fine because .png is in the allowlist.
        # Anything else (.svg, .gif animated, .exe disguised) gets rejected.
        return ""
    return suf


@router.post("/upload")
async def upload_images(
    project_id: str = Form(...),
    files: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Direct image upload — paste / drag-drop entry from the UI.

    Distinct from the scan path: scan walks a directory the user already owns
    and registers every file in place; upload accepts file bytes from the
    browser (clipboard or OS drag) and writes them under
    `<originals_path>/uploads/<yyyymmdd>/`. We auto-approve quality
    (`quality_status='passed'`) because the user deliberately uploaded these —
    no point making them click "approve" in 审核 for every drop. Tagging
    stays 'pending' so the existing tagger workflow picks them up.

    Dedup via md5(file_bytes) ⊆ existing project images. Re-uploading the
    same file no-ops and returns the existing row, mirroring scan.

    Returns ImageRecord rows plus a `skipped_duplicates` count for the
    frontend toast.
    """
    if not files:
        raise HTTPException(status_code=400, detail="no files")
    if len(files) > _UPLOAD_MAX_FILES_PER_REQUEST:
        raise HTTPException(
            status_code=400,
            detail=f"too many files (max {_UPLOAD_MAX_FILES_PER_REQUEST} per request)",
        )

    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    originals_root = Path(project.originals_path)
    today = datetime.utcnow().strftime("%Y%m%d")
    dest_dir = originals_root / "uploads" / today
    dest_dir.mkdir(parents=True, exist_ok=True)
    rel_dir = f"uploads/{today}"

    # Dedup against current "live" project images only — exclude rejected
    # (回收站) rows so that "标记淘汰 → 重新粘贴同一张" works as users expect.
    # Hard-deleted rows already aren't in the table; this filter handles the
    # soft-delete case where the row sticks around with quality_status='rejected'.
    # We need full rows (not just hashes) because the upload caller wants to
    # display / select the existing image when a duplicate is hit — e.g. AI
    # 工坊 drag-drop expects "this seed is now selected" regardless of whether
    # it was newly written or already there.
    existing_rows = (await db.execute(
        select(Image).where(
            Image.project_id == project_id,
            Image.quality_status != "rejected",
            Image.file_hash.isnot(None),
        )
    )).scalars().all()
    existing_by_hash: dict[str, Image] = {row.file_hash: row for row in existing_rows}

    created: list[Image] = []
    duplicate_existing: list[Image] = []
    skipped_invalid: list[dict] = []
    new_ids_for_sync: list[str] = []

    for f in files:
        ext = _safe_ext(f.filename or "image.png")
        if not ext:
            skipped_invalid.append({"name": f.filename or "(unnamed)", "reason": "unsupported_format"})
            continue

        data = await f.read()
        if not data:
            skipped_invalid.append({"name": f.filename or "(unnamed)", "reason": "empty"})
            continue
        if len(data) > _UPLOAD_MAX_FILE_BYTES:
            skipped_invalid.append({
                "name": f.filename or "(unnamed)",
                "reason": f"too_large ({len(data) // 1024 // 1024} MB > 50 MB)",
            })
            continue

        file_hash = hashlib.md5(data).hexdigest()
        if file_hash in existing_by_hash:
            duplicate_existing.append(existing_by_hash[file_hash])
            continue

        # Use the hash as the filename to keep collisions impossible without
        # relying on UUID — also makes "same bytes ⇒ same path" debuggable.
        out_name = f"{file_hash}{ext}"
        out_path = dest_dir / out_name
        try:
            out_path.write_bytes(data)
        except OSError as e:
            logger.warning("upload write failed for %s: %s", out_path, e)
            skipped_invalid.append({"name": f.filename or "(unnamed)", "reason": f"write_failed: {e}"})
            continue

        # Validate it actually decodes as an image. Cheap — reads header only.
        try:
            with PILImage.open(out_path) as pil:
                width, height = pil.size
        except Exception:
            out_path.unlink(missing_ok=True)
            skipped_invalid.append({"name": f.filename or "(unnamed)", "reason": "not_an_image"})
            continue

        phash_dict = compute_perceptual_hashes(out_path)
        img = Image(
            project_id=project_id,
            file_path=str(out_path),
            file_name=f.filename or out_name,
            file_hash=file_hash,
            phash=json.dumps(phash_dict) if phash_dict else None,
            width=width,
            height=height,
            file_size_kb=len(data) // 1024,
            # User-initiated uploads bypass auto QC — they wanted this image.
            # Stays subject to the 审核 review_status flow if pending matters.
            quality_status="passed",
            tag_status="pending",
            source_type="original",
            relative_dir=rel_dir,
        )
        db.add(img)
        existing_by_hash[file_hash] = img
        created.append(img)

    if created:
        await db.flush()
        new_ids_for_sync = [img.id for img in created]
        await db.commit()
        for iid in new_ids_for_sync:
            try:
                await enqueue_image_sync(iid)
            except Exception as e:
                logger.debug("oss enqueue (upload) failed for %s: %s", iid, e)

    return {
        "ok": True,
        "uploaded": len(created),
        # skipped_duplicates 保留为 count 以兼容老 toast 文案;新调用方应优先
        # 用 duplicate_images:那是被命中的现有 ImageRecord 数组,UI 可以
        # 直接拿来回填到 selectedImages,实现"拖了张已有的图也算选中了"。
        "skipped_duplicates": len(duplicate_existing),
        "duplicate_images": [_image_to_dict(img) for img in duplicate_existing],
        "skipped_invalid": skipped_invalid,
        "images": [_image_to_dict(img) for img in created],
    }


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
        "usage_count": int(getattr(img, "usage_count", 0) or 0),
        "last_used_at": (
            img.last_used_at.isoformat() if getattr(img, "last_used_at", None) else None
        ),
        "created_at": img.created_at.isoformat() if img.created_at else None,
        "updated_at": img.updated_at.isoformat() if img.updated_at else None,
    }
