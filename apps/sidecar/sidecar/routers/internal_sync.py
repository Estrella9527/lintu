"""Internal sync receiver — local sidecar pushes here, cloud writes to PG.

This router is mounted ONLY when LINTU_MODE=server. It is NOT part of the
public Open API and never exposed to UGC. Auth is a single shared bearer
token (LINTU_INTERNAL_SYNC_TOKEN) that lives in env on both ends; rotate
manually if compromised.

Why a separate auth path:
  - Public ApiKey grants per-project read; sync needs server-wide WRITE
  - Volume is bursty (initial backfill = thousands of upserts per second);
    bypassing rate-limit / quota middleware keeps the cloud responsive
  - One token, no DB lookup per call
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete as sql_delete, select

from sidecar.config import LINTU_INTERNAL_SYNC_TOKEN
from sidecar.db.models import ApiKey, Image, Project, Tag
from sidecar.db.session import get_db
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Auth ────────────────────────────────────────────────────────────────────


def require_sync_token(authorization: Optional[str] = Header(None)) -> None:
    """Bearer-token gate. Rejects when LINTU_INTERNAL_SYNC_TOKEN is unset
    or doesn't match — fail closed."""
    if not LINTU_INTERNAL_SYNC_TOKEN:
        raise HTTPException(503, "Internal sync disabled (LINTU_INTERNAL_SYNC_TOKEN not configured)")
    expected = f"Bearer {LINTU_INTERNAL_SYNC_TOKEN}"
    if authorization != expected:
        raise HTTPException(401, "Invalid internal sync token")


# ── Schema (matches the SQLAlchemy models, but as plain JSON for transport) ──


class ImageSyncBody(BaseModel):
    id: str
    project_id: str
    file_path: str
    file_name: str
    file_hash: Optional[str] = None
    phash: Optional[str] = None
    file_size_kb: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    blur_score: Optional[float] = None
    brightness: Optional[float] = None
    quality_status: Optional[str] = None
    reject_reason: Optional[str] = None
    is_kept: Optional[bool] = True
    tag_status: Optional[str] = None
    description: Optional[str] = None
    source_type: Optional[str] = None
    relative_dir: Optional[str] = None
    parent_id: Optional[str] = None
    rotated_file_path: Optional[str] = None
    orient_status: Optional[str] = None
    cdn_path: Optional[str] = None
    embedding: Optional[list[float]] = None         # 2048d float; None if not embedded yet
    embedding_model: Optional[str] = None
    text_search_blob: Optional[str] = None
    generation_metadata: Optional[dict] = None
    tagged_at: Optional[str] = None
    tag_provider: Optional[str] = None
    # Per-image tags (replaces all existing tags for this image)
    tags: list[dict[str, Any]] = []                 # [{dimension, value, source, confidence}, ...]


class BulkImagesBody(BaseModel):
    images: list[ImageSyncBody]


class ProjectSyncBody(BaseModel):
    id: str
    name: str
    originals_path: str
    workspace_path: str
    color: Optional[str] = None


class BulkProjectsBody(BaseModel):
    projects: list[ProjectSyncBody]


class ApiKeySyncBody(BaseModel):
    id: str
    key_id: str
    key_secret_hash: str
    name: str
    client_type: Optional[str] = "server"
    allowed_origins: Optional[list[str]] = None
    allowed_ips: Optional[list[str]] = None
    scopes: Optional[list[str]] = None
    rate_limit: Optional[dict] = None
    expires_at: Optional[str] = None
    is_active: bool = True


class BulkApiKeysBody(BaseModel):
    api_keys: list[ApiKeySyncBody]


class DeleteEventsBody(BaseModel):
    images: list[str] = []
    projects: list[str] = []
    api_keys: list[str] = []


class SynonymsSyncBody(BaseModel):
    """Whole-dictionary replace (small payload, simpler than diff sync)."""
    entries: dict[str, str]
    version: int = 0


class TagSchemaSyncBody(BaseModel):
    schema: dict[str, dict]


class ConfigSyncBody(BaseModel):
    """Selective config push. Local should send ONLY the keys the cloud
    needs (embedding provider + relays). Never push OSS access keys or
    generation provider keys — cloud doesn't upload or generate."""
    settings: dict[str, Any]


# ── Helpers ─────────────────────────────────────────────────────────────────


def _embedding_to_db(emb: Optional[list[float]]) -> Optional[str]:
    """Match the local sidecar's storage format: base64(float16 bytes) as
    text. Defined in engines/clip_embed.py::serialize_vector — we re-use
    its exact encoding so the same deserialize_vector() works at read
    time on both ends."""
    if emb is None:
        return None
    from sidecar.engines.clip_embed import serialize_vector
    import numpy as np
    return serialize_vector(np.asarray(emb, dtype=np.float32))


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


# ── Endpoints ───────────────────────────────────────────────────────────────


@router.post("/images", dependencies=[Depends(require_sync_token)])
async def sync_images(body: BulkImagesBody, db: AsyncSession = Depends(get_db)):
    """Idempotent upsert. Replaces tags wholesale per image (simpler than
    diffing tag rows; tag count per image is small, ≤ 30 typical)."""
    if not body.images:
        return {"upserted": 0}
    upserted = 0
    image_ids = [it.id for it in body.images]
    # 1. wipe tags for every image we're about to write — we'll re-insert
    await db.execute(sql_delete(Tag).where(Tag.image_id.in_(image_ids)))

    # 2. upsert each image
    for it in body.images:
        existing = await db.get(Image, it.id)
        fields: dict[str, Any] = {
            "project_id": it.project_id,
            "file_path": it.file_path,
            "file_name": it.file_name,
            "file_hash": it.file_hash,
            "phash": it.phash,
            "file_size_kb": it.file_size_kb,
            "width": it.width,
            "height": it.height,
            "blur_score": it.blur_score,
            "brightness": it.brightness,
            "quality_status": it.quality_status,
            "reject_reason": it.reject_reason,
            "is_kept": it.is_kept if it.is_kept is not None else True,
            "tag_status": it.tag_status,
            "description": it.description,
            "source_type": it.source_type,
            "relative_dir": it.relative_dir,
            "parent_id": it.parent_id,
            "rotated_file_path": it.rotated_file_path,
            "orient_status": it.orient_status,
            "cdn_path": it.cdn_path,
            "embedding": _embedding_to_db(it.embedding),
            "embedding_model": it.embedding_model,
            "text_search_blob": it.text_search_blob,
            "generation_metadata": it.generation_metadata,
            "tagged_at": _parse_dt(it.tagged_at),
            "tag_provider": it.tag_provider,
        }
        if existing:
            for k, v in fields.items():
                setattr(existing, k, v)
        else:
            db.add(Image(id=it.id, **fields))
        # 3. re-insert tags
        for t in it.tags or []:
            db.add(Tag(
                image_id=it.id,
                dimension=t.get("dimension"),
                value=t.get("value"),
                source=t.get("source") or "ai",
                confidence=t.get("confidence"),
            ))
        upserted += 1
    await db.commit()
    # Invalidate the in-memory IndexShard so subsequent /match builds fresh
    try:
        from sidecar.engines.text_search import index_cache
        for pid in {it.project_id for it in body.images}:
            index_cache.invalidate(pid)
    except Exception:
        pass
    logger.info("internal_sync: upserted %d images", upserted)
    return {"upserted": upserted}


@router.post("/projects", dependencies=[Depends(require_sync_token)])
async def sync_projects(body: BulkProjectsBody, db: AsyncSession = Depends(get_db)):
    if not body.projects:
        return {"upserted": 0}
    n = 0
    for p in body.projects:
        existing = await db.get(Project, p.id)
        if existing:
            existing.name = p.name
            existing.originals_path = p.originals_path
            existing.workspace_path = p.workspace_path
            existing.color = p.color
        else:
            db.add(Project(
                id=p.id, name=p.name,
                originals_path=p.originals_path,
                workspace_path=p.workspace_path,
                color=p.color,
            ))
        n += 1
    await db.commit()
    return {"upserted": n}


@router.post("/api-keys", dependencies=[Depends(require_sync_token)])
async def sync_api_keys(body: BulkApiKeysBody, db: AsyncSession = Depends(get_db)):
    if not body.api_keys:
        return {"upserted": 0}
    n = 0
    for k in body.api_keys:
        existing = await db.get(ApiKey, k.id)
        fields = {
            "key_id": k.key_id,
            "key_secret_hash": k.key_secret_hash,
            "name": k.name,
            "client_type": k.client_type,
            "allowed_origins": k.allowed_origins,
            "allowed_ips": k.allowed_ips,
            "scopes": k.scopes,
            "rate_limit": k.rate_limit,
            "expires_at": _parse_dt(k.expires_at),
            "is_active": k.is_active,
        }
        if existing:
            for f, v in fields.items():
                setattr(existing, f, v)
        else:
            db.add(ApiKey(id=k.id, **fields))
        n += 1
    await db.commit()
    return {"upserted": n}


@router.post("/deletes", dependencies=[Depends(require_sync_token)])
async def sync_deletes(body: DeleteEventsBody, db: AsyncSession = Depends(get_db)):
    """Apply tombstone events: when local user deletes something, cloud
    drops it too (otherwise UGC keeps matching ghost rows)."""
    deleted = {"images": 0, "projects": 0, "api_keys": 0}
    if body.images:
        await db.execute(sql_delete(Tag).where(Tag.image_id.in_(body.images)))
        r = await db.execute(sql_delete(Image).where(Image.id.in_(body.images)))
        deleted["images"] = r.rowcount or 0
    if body.api_keys:
        r = await db.execute(sql_delete(ApiKey).where(ApiKey.id.in_(body.api_keys)))
        deleted["api_keys"] = r.rowcount or 0
    if body.projects:
        # cascade: drop images first, then project
        for pid in body.projects:
            ids = [
                row[0] for row in (await db.execute(
                    select(Image.id).where(Image.project_id == pid)
                )).all()
            ]
            if ids:
                await db.execute(sql_delete(Tag).where(Tag.image_id.in_(ids)))
                await db.execute(sql_delete(Image).where(Image.id.in_(ids)))
        r = await db.execute(sql_delete(Project).where(Project.id.in_(body.projects)))
        deleted["projects"] = r.rowcount or 0
    await db.commit()
    # blow caches
    try:
        from sidecar.engines.text_search import index_cache
        index_cache.invalidate(None)
    except Exception:
        pass
    return {"deleted": deleted}


@router.post("/synonyms", dependencies=[Depends(require_sync_token)])
async def sync_synonyms(body: SynonymsSyncBody):
    """Replace the synonym dict file. Hot-reloads the in-process cache via
    the version bump that match_synonyms._write does."""
    from sidecar.routers.match_synonyms import SYNONYMS_FILE
    import json
    SYNONYMS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SYNONYMS_FILE.write_text(
        json.dumps({"version": body.version, "entries": body.entries},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"ok": True, "entries": len(body.entries)}


@router.post("/tag-schema", dependencies=[Depends(require_sync_token)])
async def sync_tag_schema(body: TagSchemaSyncBody):
    """Replace the tag schema file."""
    from sidecar.routers.tag_schema import SCHEMA_FILE
    import json
    SCHEMA_FILE.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_FILE.write_text(
        json.dumps(body.schema, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"ok": True, "dimensions": len(body.schema)}


@router.post("/config", dependencies=[Depends(require_sync_token)])
async def sync_config(body: ConfigSyncBody):
    """Merge incoming settings into cloud's config.json. Only the keys
    actually sent are touched — existing keys not in the payload are
    preserved (so partial pushes don't wipe what we already have)."""
    from sidecar.defaults import CONFIG_FILE
    import json
    existing: dict = {}
    if CONFIG_FILE.exists():
        try:
            existing = json.loads(CONFIG_FILE.read_text())
        except Exception:
            existing = {}

    # Audit diff before merge — 让云端能看出"是哪台桌面端推过来 + 改了哪些 key"。
    # 失败不阻塞写入。
    try:
        from sidecar.routers.config_api import _write_audit, _diff_config
        diff = _diff_config(existing, body.settings)
        if diff:
            await _write_audit(diff, source="cloud_sync")
    except Exception:
        pass

    existing.update(body.settings)
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(existing, ensure_ascii=False, indent=2))
    return {"ok": True, "updated_keys": list(body.settings.keys())}


@router.get("/health", dependencies=[Depends(require_sync_token)])
async def sync_health():
    """Liveness endpoint for the local sync_worker to confirm cloud is up."""
    return {"status": "ok", "ts": datetime.utcnow().isoformat()}
