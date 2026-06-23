import asyncio
import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
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
    in_library: Optional[bool] = None,
    tag_status: Optional[str] = None,
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
    if in_library is not None:
        query = query.where(Image.in_library == in_library)
    # 人工审标队列:按打标状态过滤(pending=待打标 / tagged=AI已标 / manual=已人工)
    if tag_status:
        query = query.where(Image.tag_status == tag_status)
    # 「全部图片」根视图(未选文件夹、未筛来源)默认隐藏 AI 生成草稿 —— 它们只在
    # 「AI生成」文件夹(folder/folder_prefix 命中)或显式 source_type=generated 时出现,
    # 避免 AI 草稿和真实照片在「全部图片」里混淆。
    if folder is None and not folder_prefix and not source_type:
        query = query.where(Image.source_type != "generated")
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
    in_library: Optional[bool] = None,
    tag_status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    base = select(Image).where(Image.project_id == project_id)
    query = _apply_image_filters(
        base, search=search, status=status, scene=scene, season=season,
        weather=weather, angle=angle, people=people, facility=facility,
        usage=usage, style=style, mood=mood, palette=palette, theme=theme,
        composition=composition, source_type=source_type,
        folder=folder, folder_prefix=folder_prefix, prompt_id=prompt_id,
        parent_id=parent_id, in_library=in_library, tag_status=tag_status,
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
    in_library: Optional[bool] = None,
    tag_status: Optional[str] = None,
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
        parent_id=parent_id, in_library=in_library, tag_status=tag_status,
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
    in_library: Optional[bool] = None,
    tag_status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Return every distinct relative_dir with its image count.

    The frontend expands this flat list into a tree. Empty relative_dir is
    reported as the root (label: "/", value: "").

    in_library 过滤要和资产库网格(list_images)保持一致,否则文件夹数字会把
    "未入库的画布草稿/生成图"也算进去,和网格显示的张数对不上。
    """
    q = (
        select(Image.relative_dir, func.count(Image.id).label("count"))
        .where(Image.project_id == project_id)
        .group_by(Image.relative_dir)
    )
    if source_type:
        q = q.where(Image.source_type == source_type)
    if in_library is not None:
        q = q.where(Image.in_library == in_library)
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


def _cdn_fallback(img: Image, *, thumb_size: int | None = None) -> RedirectResponse | None:
    """本地文件缺失时 302 到 CDN —— 多设备同步拉回的图只有元数据没有本地文件,
    浏览/缩略全靠云端副本。thumb_size 给定时跳到对应缩略 key(OSS 只有 300/800,
    128 就近用 300);否则跳原图(cdn_path)。CDN 未配置或该图没传过 → None(404 照旧)。"""
    if not getattr(img, "cdn_path", None):
        return None
    try:
        from sidecar.engines.oss_sync import get_storage, object_key_for
        storage = get_storage()
        if not storage.is_read_configured():
            return None
        if thumb_size is not None:
            kind = "thumb_300" if thumb_size <= 300 else "thumb_800"
            key = object_key_for(img.id, kind, "jpg")
        else:
            key = img.cdn_path
        return RedirectResponse(storage.public_url(key), status_code=302)
    except Exception:
        logger.debug("cdn fallback failed for %s", img.id, exc_info=True)
        return None


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
            fb = _cdn_fallback(img, thumb_size=size)
            if fb:
                return fb
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


class AddTagBody(BaseModel):
    dimension: str
    value: str


async def _refresh_tag_state(db: AsyncSession, image_id: str) -> None:
    """改标后统一收口:重算 text_search_blob(文搜召回)+ 维护 tag_status +
    入云端同步队列。所有人工增/删/改标签端点都走这里,避免文搜失真/多设备不同步。
    会 commit 当前事务(含调用方挂起的 Tag 增删)。"""
    from sidecar.engines.tagger import build_text_search_blob
    img = await db.get(Image, image_id)
    if not img:
        return
    rows = (await db.execute(
        select(Tag.value, Tag.source).where(Tag.image_id == image_id)
    )).all()
    values = [v for v, _ in rows]
    has_manual = any(s == "manual" for _, s in rows)
    img.text_search_blob = build_text_search_blob(img.file_name, img.description, values)
    if has_manual:
        img.tag_status = "manual"
    elif rows:
        img.tag_status = "tagged"
    await db.commit()
    try:
        from sidecar.scheduler.cloud_sync_worker import enqueue_image_upsert
        await enqueue_image_upsert(image_id)
    except Exception as e:
        logger.debug("cloud sync enqueue (tags) failed for %s: %s", image_id, e)


async def _image_tags_payload(db: AsyncSession, image_id: str) -> dict:
    rows = (await db.execute(select(Tag).where(Tag.image_id == image_id))).scalars().all()
    return {"ok": True, "tags": [
        {"id": t.id, "dimension": t.dimension, "value": t.value,
         "source": t.source, "confidence": t.confidence}
        for t in rows
    ]}


class ImagePatchBody(BaseModel):
    """Lightweight PATCH for single-image field updates.

    review_status — 推到审核队列 / 改审核态。
    is_listed     — 上架 / 下架(决定是否进 UGC 匹配候选池,与审核正交)。
    in_library    — 加入 / 移出资产库(画布草稿 → 入库);置 True 时入队推 OSS。"""
    review_status: Optional[str] = None
    is_listed: Optional[bool] = None
    in_library: Optional[bool] = None


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
    enqueue_oss = body.in_library is True and not img.in_library  # 仅"从未入库→入库"才推
    if body.in_library is not None:
        img.in_library = body.in_library
    await db.commit()
    if enqueue_oss:
        try:
            await enqueue_image_sync(image_id)
        except Exception as e:
            logger.debug("oss enqueue (add to library) failed for %s: %s", image_id, e)
    # 状态变更推云端(多人协作:上下架/入库态跨端流转;pending 会被 push 过滤)
    if body.review_status is not None or body.is_listed is not None or body.in_library is not None:
        try:
            from sidecar.scheduler.cloud_sync_worker import enqueue_image_upsert
            await enqueue_image_upsert(image_id)
        except Exception as e:
            logger.debug("cloud sync enqueue failed for %s: %s", image_id, e)
    return {"ok": True, "id": image_id, "review_status": img.review_status,
            "is_listed": img.is_listed, "in_library": img.in_library}


class LibraryBody(BaseModel):
    image_ids: list[str]
    in_library: bool = True


@router.post("/batch/library")
async def batch_set_library(body: LibraryBody, db: AsyncSession = Depends(get_db)):
    """批量加入 / 移出资产库。加入(True)时把"原本不在库"的图入队推 OSS。"""
    if not body.image_ids:
        return {"ok": True, "updated": 0}
    rows = (await db.execute(
        select(Image).where(Image.id.in_(body.image_ids))
    )).scalars().all()
    to_enqueue: list[str] = []
    for img in rows:
        if body.in_library and not img.in_library:
            to_enqueue.append(img.id)
        img.in_library = body.in_library
    await db.commit()
    for iid in to_enqueue:
        try:
            await enqueue_image_sync(iid)
        except Exception as e:
            logger.debug("oss enqueue (batch add to library) failed for %s: %s", iid, e)
    # 入库态推云端(跨端流转)
    from sidecar.scheduler.cloud_sync_worker import enqueue_image_upsert
    for img in rows:
        try:
            await enqueue_image_upsert(img.id)
        except Exception as e:
            logger.debug("cloud sync enqueue failed for %s: %s", img.id, e)
    return {"ok": True, "updated": len(rows), "in_library": body.in_library}


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
    # 上下架推云端(跨端流转;pending 图会被 push 的 approved 过滤拦下)
    from sidecar.scheduler.cloud_sync_worker import enqueue_image_upsert
    for img in rows:
        try:
            await enqueue_image_upsert(img.id)
        except Exception as e:
            logger.debug("cloud sync enqueue failed for %s: %s", img.id, e)
    return {"ok": True, "updated": len(rows), "is_listed": body.is_listed}


def _validate_tag(schema: dict, dimension: str, value: str) -> dict:
    """校验 维度+取值 在标签体系内,返回该维 schema;不合法抛 400(受控取值)。"""
    dim_schema = schema.get(dimension)
    if not dim_schema:
        raise HTTPException(400, f"未知标签维度: {dimension}")
    if value not in (dim_schema.get("values") or []):
        raise HTTPException(400, f"取值不在「{dim_schema.get('label', dimension)}」体系内: {value}")
    return dim_schema


@router.put("/{image_id}/tags")
async def update_tags(image_id: str, body: UpdateTagsBody, db: AsyncSession = Depends(get_db)):
    """按维度替换:只替换 body 里出现的维度(删旧插新,source=manual),不碰未提及的
    维度(保留其它 AI/人工标签)。受控校验。修复旧的"清空所有 AI 标签"误删问题。"""
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    from sidecar.routers.tag_schema import _read_schema
    schema = _read_schema()
    for dimension, value in body.tags.items():
        values = value if isinstance(value, list) else [value]
        for v in values:
            _validate_tag(schema, dimension, v)
        existing = (await db.execute(
            select(Tag).where(Tag.image_id == image_id).where(Tag.dimension == dimension)
        )).scalars().all()
        for t in existing:
            await db.delete(t)
        for v in values:
            db.add(Tag(image_id=image_id, dimension=dimension, value=v, source="manual", confidence=1.0))
    await _refresh_tag_state(db, image_id)
    return await _image_tags_payload(db, image_id)


@router.post("/{image_id}/tags")
async def add_tag(image_id: str, body: AddTagBody, db: AsyncSession = Depends(get_db)):
    """加一条人工标签(source=manual)。单选维先删本维旧值(replace),多选维去重追加。
    受控:取值必须在标签体系内。不动其它维度/AI 标签 → 适合纠正/补一个标签。"""
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    from sidecar.routers.tag_schema import _read_schema
    dim_schema = _validate_tag(_read_schema(), body.dimension, body.value)
    existing = (await db.execute(
        select(Tag).where(Tag.image_id == image_id).where(Tag.dimension == body.dimension)
    )).scalars().all()
    if bool(dim_schema.get("multi")):
        if any(t.value == body.value for t in existing):
            return await _image_tags_payload(db, image_id)  # 幂等:已有同值
    else:
        for t in existing:  # 单选维:替换
            await db.delete(t)
    db.add(Tag(image_id=image_id, dimension=body.dimension, value=body.value,
               source="manual", confidence=1.0))
    await _refresh_tag_state(db, image_id)
    return await _image_tags_payload(db, image_id)


@router.delete("/{image_id}/tags/{tag_id}")
async def delete_tag(image_id: str, tag_id: str, db: AsyncSession = Depends(get_db)):
    """删一条标签(AI 或人工皆可,用于纠正 AI 错标)。"""
    tag = await db.get(Tag, tag_id)
    if not tag or tag.image_id != image_id:
        raise HTTPException(404, "Tag not found")
    await db.delete(tag)
    await _refresh_tag_state(db, image_id)
    return await _image_tags_payload(db, image_id)


class BatchTagsBody(BaseModel):
    image_ids: list[str]
    tags: dict            # {dimension: [values] | value}
    mode: str = "add"     # "add" 追加(单选维仍替换该维) | "replace_dim" 按维度删旧插新


@router.post("/batch/tags")
async def batch_tags(body: BatchTagsBody, db: AsyncSession = Depends(get_db)):
    """批量给选中图打人工标签(source=manual)。受控校验;每图收口(刷新文搜+入云端同步)。"""
    if not body.image_ids or not body.tags:
        return {"ok": True, "updated": 0}
    from sidecar.routers.tag_schema import _read_schema
    schema = _read_schema()
    norm: dict[str, list[str]] = {}
    for dimension, value in body.tags.items():
        values = value if isinstance(value, list) else [value]
        for v in values:
            _validate_tag(schema, dimension, v)
        norm[dimension] = values
    updated = 0
    for iid in body.image_ids:
        img = await db.get(Image, iid)
        if not img:
            continue
        for dimension, values in norm.items():
            multi = bool(schema[dimension].get("multi"))
            existing = (await db.execute(
                select(Tag).where(Tag.image_id == iid).where(Tag.dimension == dimension)
            )).scalars().all()
            if body.mode == "replace_dim" or not multi:
                for t in existing:
                    await db.delete(t)
                existing = []
            have = {t.value for t in existing}
            for v in values:
                if v not in have:
                    db.add(Tag(image_id=iid, dimension=dimension, value=v,
                               source="manual", confidence=1.0))
        await _refresh_tag_state(db, iid)
        updated += 1
    return {"ok": True, "updated": updated}


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
        fb = _cdn_fallback(img)
        if fb:
            return fb
        raise HTTPException(404, "Source file not found")
    mime = _EXT_MIME.get(source.suffix.lower(), "application/octet-stream")
    return FileResponse(
        source,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ── Download original ──


@router.get("/{image_id}/svg")
async def export_svg(
    image_id: str,
    mode: str = Query("ai", description="ai=提示词走 ChatGPT 直接生成矢量(默认) | trace=vtracer 位图描摹"),
    regenerate: bool = Query(False, description="true=忽略缓存重新生成"),
    db: AsyncSession = Depends(get_db),
):
    """导出 SVG(矢量)。

    默认 ai 模式:把图的提示词(原片则附图看图)交给 ChatGPT 类模型直接产出
    SVG 代码 — 得到可编辑的矢量插画。trace 模式:vtracer 位图描摹(色块风)。
    两种结果分开缓存到 derived/svg_ai|svg/。
    """
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")

    from sidecar.config import DERIVED_DIR
    sub = "svg_ai" if mode == "ai" else "svg"
    out_dir = DERIVED_DIR / sub / (image_id[:2] or "_")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{image_id}.svg"
    if regenerate:
        out_path.unlink(missing_ok=True)

    if mode == "ai":
        if not out_path.exists():
            from sidecar.engines.svg_ai import SvgAiError, generate_svg_via_llm
            prompt = None
            meta = img.generation_metadata or {}
            if isinstance(meta, dict):
                prompt = (meta.get("prompt") or "").strip() or None
            src = Path(effective_file_path(img))
            src_path = str(src) if src.exists() else None
            aspect = None
            if img.width and img.height:
                from math import gcd
                g = gcd(img.width, img.height) or 1
                aspect = (img.width // g, img.height // g)
            try:
                svg = await generate_svg_via_llm(prompt=prompt, image_path=src_path, aspect=aspect)
            except SvgAiError as e:
                raise HTTPException(502, str(e))
            out_path.write_text(svg, encoding="utf-8")
        stem = Path(img.file_name or image_id).stem
        return FileResponse(
            out_path, media_type="image/svg+xml", filename=f"{stem}.svg",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    if not out_path.exists():
        source = Path(effective_file_path(img))
        tmp_dl: Path | None = None
        if not source.exists():
            # 本地无文件(多设备拉回的图)→ 从 OSS 取临时副本
            if not getattr(img, "cdn_path", None):
                raise HTTPException(404, "Source file not found (且无云端副本)")
            from sidecar.engines.oss_sync import get_storage
            storage = get_storage()
            tmp_dl = out_dir / f"{image_id}.src.tmp"
            try:
                storage.download(img.cdn_path, str(tmp_dl))
                source = tmp_dl
            except Exception as e:
                raise HTTPException(502, f"云端取图失败: {e}")
        tmp_png = out_dir / f"{image_id}.in.png"
        try:
            import vtracer

            def _convert():
                # vtracer 的 Rust 层打不开含中文/全角字符的路径,且对 HEIC 等
                # 格式支持有限 —— 先用 PIL 标准化成 ASCII 路径的 PNG 再喂它。
                # 顺便限长边 1600:矢量化耗时与 SVG 体积都随像素暴涨,1600 足够。
                from PIL import Image as PILImage
                with PILImage.open(source) as im:
                    im = im.convert("RGB")
                    im.thumbnail((1600, 1600))
                    im.save(tmp_png, "PNG")
                vtracer.convert_image_to_svg_py(str(tmp_png), str(out_path), colormode="color")

            # CPU 密集 Rust 调用,丢线程池避免卡 event loop
            await asyncio.to_thread(_convert)
        except HTTPException:
            raise
        except asyncio.CancelledError:
            raise
        except BaseException as e:   # pyo3 panic 是 BaseException,普通 except 抓不到
            out_path.unlink(missing_ok=True)
            logger.exception("SVG 转换失败 %s", image_id)
            raise HTTPException(500, f"矢量化失败: {str(e)[:200]}")
        finally:
            tmp_png.unlink(missing_ok=True)
            if tmp_dl is not None:
                tmp_dl.unlink(missing_ok=True)

    stem = Path(img.file_name or image_id).stem
    return FileResponse(
        out_path,
        media_type="image/svg+xml",
        filename=f"{stem}.svg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


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
        fb = _cdn_fallback(img)
        if fb:
            return fb
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
    # 资产库直接上传 → True(进库 + 推 OSS);AI 工坊画布拖入 → False(只是画布草稿)
    in_library: bool = Form(True),
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
            in_library=in_library,
            relative_dir=rel_dir,
        )
        db.add(img)
        existing_by_hash[file_hash] = img
        created.append(img)

    if created:
        await db.flush()
        new_ids_for_sync = [img.id for img in created]
        await db.commit()
        # 只有「进资产库」的上传才推 OSS;画布草稿(in_library=False)不推。
        if in_library:
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
        "review_status": img.review_status,
        "is_listed": bool(img.is_listed),
        "in_library": bool(img.in_library),
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
