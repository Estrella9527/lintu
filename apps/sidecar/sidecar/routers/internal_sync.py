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

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, delete as sql_delete, or_, select

from sidecar.config import LINTU_INTERNAL_SYNC_TOKEN
from sidecar.db.models import (
    ApiKey, BatchSubtask, DuplicateGroup, Image, MatchFeedback, Organization,
    OrganizationMember, OssSyncJob, Project, ProjectMember, SyncTombstone,
    Tag, User,
)
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
    # 协作状态三件套(跨端流转;老客户端不传 → None,upsert 时跳过不覆盖)
    review_status: Optional[str] = None
    is_listed: Optional[bool] = None
    in_library: Optional[bool] = None
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
    org_id: Optional[str] = None


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
    users: list[str] = []
    orgs: list[str] = []
    org_members: list[str] = []
    project_members: list[str] = []


# ── 多设备同步:身份层实体(方案A 需要,新设备登录要先有 user/org/成员关系)──

class UserSyncBody(BaseModel):
    id: str
    phone: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    status: Optional[str] = "active"
    is_root: bool = False
    is_platform_owner: bool = False


class BulkUsersBody(BaseModel):
    users: list[UserSyncBody]


class OrgSyncBody(BaseModel):
    id: str
    name: str
    slug: str
    logo_url: Optional[str] = None
    contact_email: Optional[str] = None
    plan: Optional[str] = "free"
    storage_quota_gb: Optional[int] = 10
    status: Optional[str] = "active"


class BulkOrgsBody(BaseModel):
    orgs: list[OrgSyncBody]


class OrgMemberSyncBody(BaseModel):
    id: str
    org_id: str
    user_id: str
    role: Optional[str] = "member"
    invited_by: Optional[str] = None


class BulkOrgMembersBody(BaseModel):
    org_members: list[OrgMemberSyncBody]


class ProjectMemberSyncBody(BaseModel):
    id: str
    project_id: str
    user_id: str
    role: Optional[str] = "editor"
    invited_by: Optional[str] = None


class BulkProjectMembersBody(BaseModel):
    project_members: list[ProjectMemberSyncBody]


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


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


async def record_tombstones(db: AsyncSession, entity_type: str, entity_ids: list[str]) -> None:
    """登记删除墓碑(幂等,后写胜)。云端 apply 删除时调用,让其它设备 pull 增量
    feed 时能看到"这些 id 被删了"。不单独 commit — 由调用方事务统一提交。"""
    if not entity_ids:
        return
    now = datetime.utcnow()
    existing = {
        t.entity_id: t for t in (await db.execute(
            select(SyncTombstone)
            .where(SyncTombstone.entity_type == entity_type)
            .where(SyncTombstone.entity_id.in_(entity_ids))
        )).scalars().all()
    }
    for eid in entity_ids:
        row = existing.get(eid)
        if row:
            row.deleted_at = now
        else:
            db.add(SyncTombstone(entity_type=entity_type, entity_id=eid, deleted_at=now))


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
        # 协作状态三件套:老客户端不传(None)就不覆盖现有值,避免把
        # 云端已对齐的 审核/上架/入库 态冲回默认。
        if it.review_status is not None:
            fields["review_status"] = it.review_status
        if it.is_listed is not None:
            fields["is_listed"] = it.is_listed
        if it.in_library is not None:
            fields["in_library"] = it.in_library
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
            if p.org_id is not None:
                existing.org_id = p.org_id
        else:
            db.add(Project(
                id=p.id, name=p.name,
                originals_path=p.originals_path,
                workspace_path=p.workspace_path,
                color=p.color,
                org_id=p.org_id,
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


async def _purge_image_refs(db: AsyncSession, image_ids: list[str]) -> None:
    """删 images 前清掉所有指向它们的外键引用,否则 PG 直接 FK 违约 500
    (本次教训:match_feedback 引用参与过 UGC 匹配的图)。
    SQLite 端没开 FK 强制所以从未暴露;PG 端必须按依赖顺序清。"""
    from sqlalchemy import update as sql_update
    CHUNK = 500
    for i in range(0, len(image_ids), CHUNK):
        ids = image_ids[i:i + CHUNK]
        await db.execute(sql_delete(MatchFeedback).where(MatchFeedback.image_id.in_(ids)))
        await db.execute(sql_delete(OssSyncJob).where(OssSyncJob.image_id.in_(ids)))
        await db.execute(sql_delete(BatchSubtask).where(
            or_(BatchSubtask.seed_image_id.in_(ids), BatchSubtask.output_image_id.in_(ids))
        ))
        await db.execute(sql_update(DuplicateGroup)
                         .where(DuplicateGroup.kept_image_id.in_(ids))
                         .values(kept_image_id=None))
        # 子图引用(parent_id 自引用):指向被删图的子图置空血缘
        await db.execute(sql_update(Image).where(Image.parent_id.in_(ids)).values(parent_id=None))
        await db.execute(sql_delete(Tag).where(Tag.image_id.in_(ids)))


@router.post("/deletes", dependencies=[Depends(require_sync_token)])
async def sync_deletes(body: DeleteEventsBody, db: AsyncSession = Depends(get_db)):
    """Apply delete events: when local user deletes something, cloud drops it
    too (otherwise UGC keeps matching ghost rows). Also writes a SyncTombstone
    per deleted id so OTHER devices see the deletion via the changes feed."""
    deleted = {"images": 0, "projects": 0, "api_keys": 0,
               "users": 0, "orgs": 0, "org_members": 0, "project_members": 0}
    # 级联删图收集到的 image id(项目删除时)也要登记墓碑
    cascaded_image_ids: list[str] = []
    if body.images:
        await _purge_image_refs(db, body.images)
        r = await db.execute(sql_delete(Image).where(Image.id.in_(body.images)))
        deleted["images"] = r.rowcount or 0
        await record_tombstones(db, "image", body.images)
    if body.api_keys:
        r = await db.execute(sql_delete(ApiKey).where(ApiKey.id.in_(body.api_keys)))
        deleted["api_keys"] = r.rowcount or 0
        await record_tombstones(db, "api_key", body.api_keys)
    if body.projects:
        # cascade: drop images first, then project
        for pid in body.projects:
            ids = [
                row[0] for row in (await db.execute(
                    select(Image.id).where(Image.project_id == pid)
                )).all()
            ]
            if ids:
                cascaded_image_ids.extend(ids)
                await _purge_image_refs(db, ids)
                await db.execute(sql_delete(Image).where(Image.id.in_(ids)))
        r = await db.execute(sql_delete(Project).where(Project.id.in_(body.projects)))
        deleted["projects"] = r.rowcount or 0
        await record_tombstones(db, "project", body.projects)
        if cascaded_image_ids:
            await record_tombstones(db, "image", cascaded_image_ids)
    if body.project_members:
        r = await db.execute(sql_delete(ProjectMember).where(ProjectMember.id.in_(body.project_members)))
        deleted["project_members"] = r.rowcount or 0
        await record_tombstones(db, "project_member", body.project_members)
    if body.org_members:
        r = await db.execute(sql_delete(OrganizationMember).where(OrganizationMember.id.in_(body.org_members)))
        deleted["org_members"] = r.rowcount or 0
        await record_tombstones(db, "org_member", body.org_members)
    if body.orgs:
        r = await db.execute(sql_delete(Organization).where(Organization.id.in_(body.orgs)))
        deleted["orgs"] = r.rowcount or 0
        await record_tombstones(db, "org", body.orgs)
    if body.users:
        r = await db.execute(sql_delete(User).where(User.id.in_(body.users)))
        deleted["users"] = r.rowcount or 0
        await record_tombstones(db, "user", body.users)
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


# ── 身份层 upsert 接收端(方案A 多设备同步)──────────────────────────────────


@router.post("/users", dependencies=[Depends(require_sync_token)])
async def sync_users(body: BulkUsersBody, db: AsyncSession = Depends(get_db)):
    """Idempotent upsert。到达顺序裁决(后到的 push 胜),updated_at 由模型
    onupdate 写为云端时刻,驱动 changes feed 游标。不同步验证码/会话/密钥。"""
    if not body.users:
        return {"upserted": 0}
    n = 0
    for u in body.users:
        existing = await db.get(User, u.id)
        fields = {
            "phone": u.phone, "display_name": u.display_name,
            "avatar_url": u.avatar_url, "status": u.status or "active",
            "is_root": u.is_root, "is_platform_owner": u.is_platform_owner,
        }
        if existing:
            for k, v in fields.items():
                setattr(existing, k, v)
        else:
            db.add(User(id=u.id, **fields))
        n += 1
    await db.commit()
    return {"upserted": n}


@router.post("/orgs", dependencies=[Depends(require_sync_token)])
async def sync_orgs(body: BulkOrgsBody, db: AsyncSession = Depends(get_db)):
    if not body.orgs:
        return {"upserted": 0}
    n = 0
    for o in body.orgs:
        existing = await db.get(Organization, o.id)
        fields = {
            "name": o.name, "slug": o.slug, "logo_url": o.logo_url,
            "contact_email": o.contact_email, "plan": o.plan or "free",
            "storage_quota_gb": o.storage_quota_gb if o.storage_quota_gb is not None else 10,
            "status": o.status or "active",
        }
        if existing:
            for k, v in fields.items():
                setattr(existing, k, v)
        else:
            db.add(Organization(id=o.id, **fields))
        n += 1
    await db.commit()
    return {"upserted": n}


@router.post("/org-members", dependencies=[Depends(require_sync_token)])
async def sync_org_members(body: BulkOrgMembersBody, db: AsyncSession = Depends(get_db)):
    if not body.org_members:
        return {"upserted": 0}
    n = 0
    for m in body.org_members:
        existing = await db.get(OrganizationMember, m.id)
        fields = {"org_id": m.org_id, "user_id": m.user_id,
                  "role": m.role or "member", "invited_by": m.invited_by}
        if existing:
            for k, v in fields.items():
                setattr(existing, k, v)
        else:
            db.add(OrganizationMember(id=m.id, **fields))
        n += 1
    await db.commit()
    return {"upserted": n}


@router.post("/project-members", dependencies=[Depends(require_sync_token)])
async def sync_project_members(body: BulkProjectMembersBody, db: AsyncSession = Depends(get_db)):
    if not body.project_members:
        return {"upserted": 0}
    n = 0
    for m in body.project_members:
        existing = await db.get(ProjectMember, m.id)
        fields = {"project_id": m.project_id, "user_id": m.user_id,
                  "role": m.role or "editor", "invited_by": m.invited_by}
        if existing:
            for k, v in fields.items():
                setattr(existing, k, v)
        else:
            db.add(ProjectMember(id=m.id, **fields))
        n += 1
    await db.commit()
    return {"upserted": n}


# ── 增量拉取 feed(方案A 核心):设备 pull "云端 since 之后变了什么" ──────────

# images 单次返回上限(大表分页);小表(project/user/org/成员)体量小,整段返回。
_FEED_IMAGE_LIMIT = 500
_ALL_TYPES = ["image", "project", "api_key", "user", "org", "org_member", "project_member"]


def _parse_cursor(s: Optional[str]) -> tuple[datetime, str]:
    """游标 = "<updated_at iso>|<id>" 复合键,抗同毫秒并列(冷启动回填易出现
    大量相同 updated_at)。空 → (epoch, "")。"""
    if not s:
        return (datetime.min, "")
    ts_str, _, eid = s.partition("|")
    return (_parse_dt(ts_str) or datetime.min, eid)


def _img_to_body(img: Image, tags: list[dict]) -> dict:
    from sidecar.engines.clip_embed import deserialize_vector
    emb_arr = deserialize_vector(img.embedding) if img.embedding else None
    return {
        "id": img.id, "project_id": img.project_id, "file_path": img.file_path,
        "file_name": img.file_name, "file_hash": img.file_hash, "phash": img.phash,
        "file_size_kb": img.file_size_kb, "width": img.width, "height": img.height,
        "blur_score": img.blur_score, "brightness": img.brightness,
        "quality_status": img.quality_status, "reject_reason": img.reject_reason,
        "is_kept": img.is_kept, "tag_status": img.tag_status, "description": img.description,
        "source_type": img.source_type, "relative_dir": img.relative_dir,
        "parent_id": img.parent_id, "rotated_file_path": img.rotated_file_path,
        "orient_status": img.orient_status, "cdn_path": img.cdn_path,
        "embedding": emb_arr.tolist() if emb_arr is not None else None,
        "embedding_model": img.embedding_model, "text_search_blob": img.text_search_blob,
        "generation_metadata": img.generation_metadata,
        "tagged_at": _iso(img.tagged_at), "tag_provider": img.tag_provider,
        "review_status": img.review_status,
        "is_listed": bool(img.is_listed) if img.is_listed is not None else None,
        "in_library": bool(img.in_library) if img.in_library is not None else None,
        "updated_at": _iso(img.updated_at), "tags": tags,
    }


@router.get("/changes", dependencies=[Depends(require_sync_token)])
async def sync_changes(
    since: Optional[str] = Query(None, description='游标 "<updated_at iso>|<id>";首拉留空'),
    types: Optional[str] = Query(None, description="逗号分隔实体类型;留空=全部"),
    db: AsyncSession = Depends(get_db),
):
    """方案A 增量 feed:返回云端在 since 之后的变更(upsert)+ 删除(墓碑)。

    - images:复合游标分页(updated_at, id),单次上限 _FEED_IMAGE_LIMIT;
    - 其它表体量小,since 之后整段返回;
    - deletes:since 之后的墓碑;
    - cursor:images 满页 → 末条 (updated_at|id) 且 has_more=true;否则 → now(消费完所有 ≤now 的小表/删除变更);
    设备据此循环 pull 直到 has_more=false。
    """
    want = set((types or "").split(",")) & set(_ALL_TYPES) if types else set(_ALL_TYPES)
    since_ts, since_id = _parse_cursor(since)
    now = datetime.utcnow()
    out: dict = {"images": [], "projects": [], "api_keys": [], "users": [],
                 "orgs": [], "org_members": [], "project_members": [],
                 "deletes": {}, "cursor": since or "", "has_more": False}

    # 1. images — 复合游标分页
    has_more = False
    if "image" in want:
        rows = (await db.execute(
            select(Image)
            .where(or_(Image.updated_at > since_ts,
                       and_(Image.updated_at == since_ts, Image.id > since_id)))
            .order_by(Image.updated_at.asc(), Image.id.asc())
            .limit(_FEED_IMAGE_LIMIT)
        )).scalars().all()
        if rows:
            img_ids = [r.id for r in rows]
            tag_rows = (await db.execute(
                select(Tag.image_id, Tag.dimension, Tag.value, Tag.source, Tag.confidence)
                .where(Tag.image_id.in_(img_ids))
            )).all()
            tags_by: dict[str, list[dict]] = {}
            for iid, dim, val, src, conf in tag_rows:
                tags_by.setdefault(iid, []).append(
                    {"dimension": dim, "value": val, "source": src, "confidence": conf})
            out["images"] = [_img_to_body(r, tags_by.get(r.id, [])) for r in rows]
            if len(rows) == _FEED_IMAGE_LIMIT:
                has_more = True
                last = rows[-1]
                out["cursor"] = f"{_iso(last.updated_at)}|{last.id}"

    # 2. 小表 — since 之后整段(idempotent upsert,体量小)
    if "project" in want:
        ps = (await db.execute(select(Project).where(Project.updated_at > since_ts))).scalars().all()
        out["projects"] = [{
            "id": p.id, "name": p.name, "originals_path": p.originals_path,
            "workspace_path": p.workspace_path, "color": p.color, "org_id": p.org_id,
            "updated_at": _iso(p.updated_at),
        } for p in ps]
    if "api_key" in want:
        ks = (await db.execute(select(ApiKey).where(ApiKey.updated_at > since_ts))).scalars().all()
        out["api_keys"] = [{
            "id": k.id, "key_id": k.key_id, "key_secret_hash": k.key_secret_hash,
            "name": k.name, "client_type": k.client_type, "allowed_origins": k.allowed_origins,
            "allowed_ips": k.allowed_ips, "scopes": k.scopes, "rate_limit": k.rate_limit,
            "expires_at": _iso(k.expires_at), "is_active": k.is_active,
            "updated_at": _iso(k.updated_at),
        } for k in ks]
    if "user" in want:
        us = (await db.execute(select(User).where(User.updated_at > since_ts))).scalars().all()
        out["users"] = [{
            "id": u.id, "phone": u.phone, "display_name": u.display_name,
            "avatar_url": u.avatar_url, "status": u.status, "is_root": u.is_root,
            "is_platform_owner": u.is_platform_owner, "updated_at": _iso(u.updated_at),
        } for u in us]
    if "org" in want:
        os_ = (await db.execute(select(Organization).where(Organization.updated_at > since_ts))).scalars().all()
        out["orgs"] = [{
            "id": o.id, "name": o.name, "slug": o.slug, "logo_url": o.logo_url,
            "contact_email": o.contact_email, "plan": o.plan,
            "storage_quota_gb": o.storage_quota_gb, "status": o.status,
            "updated_at": _iso(o.updated_at),
        } for o in os_]
    if "org_member" in want:
        oms = (await db.execute(select(OrganizationMember).where(OrganizationMember.updated_at > since_ts))).scalars().all()
        out["org_members"] = [{
            "id": m.id, "org_id": m.org_id, "user_id": m.user_id,
            "role": m.role, "invited_by": m.invited_by, "updated_at": _iso(m.updated_at),
        } for m in oms]
    if "project_member" in want:
        pms = (await db.execute(select(ProjectMember).where(ProjectMember.updated_at > since_ts))).scalars().all()
        out["project_members"] = [{
            "id": m.id, "project_id": m.project_id, "user_id": m.user_id,
            "role": m.role, "invited_by": m.invited_by, "updated_at": _iso(m.updated_at),
        } for m in pms]

    # 3. deletes — since 之后的墓碑(按类型分组)
    tomb_type_map = {"image": "images", "project": "projects", "api_key": "api_keys",
                     "user": "users", "org": "orgs", "org_member": "org_members",
                     "project_member": "project_members"}
    tombs = (await db.execute(
        select(SyncTombstone)
        .where(SyncTombstone.deleted_at > since_ts)
        .where(SyncTombstone.entity_type.in_(want))
    )).scalars().all()
    deletes: dict[str, list[str]] = {}
    for t in tombs:
        deletes.setdefault(tomb_type_map.get(t.entity_type, t.entity_type), []).append(t.entity_id)
    out["deletes"] = deletes

    # 4. 游标推进:images 未满页(已抽干)→ 游标推到 now,消费完所有小表/删除变更
    out["has_more"] = has_more
    if not has_more:
        out["cursor"] = f"{_iso(now)}|~"  # "~" 排在任何 id 之后,确保 = now 的也被含入下次 > 判断的边界
    return out


@router.get("/health", dependencies=[Depends(require_sync_token)])
async def sync_health():
    """Liveness endpoint for the local sync_worker to confirm cloud is up."""
    return {"status": "ok", "ts": datetime.utcnow().isoformat()}


# ── 轻量查询(桌面端 OSS 图库联查"云端是否已发布") ──────────────────────


class ImagesBriefBody(BaseModel):
    """按 id 或 cdn_path 批量查云端图的简要信息。两个列表取并集匹配。"""
    ids: list[str] = []
    cdn_paths: list[str] = []


@router.post("/images-brief", dependencies=[Depends(require_sync_token)])
async def images_brief(body: ImagesBriefBody, db: AsyncSession = Depends(get_db)):
    """桌面端 OSS 图库用:这些对象对应的图,云端(组织已发布资产)有没有记录。
    轻量返回(无 embedding / 无 tags 明细,只有 tag_count);详情走 image-brief/{id}。"""
    if not body.ids and not body.cdn_paths:
        return {"items": []}
    conds = []
    if body.ids:
        conds.append(Image.id.in_(body.ids))
    if body.cdn_paths:
        conds.append(Image.cdn_path.in_(body.cdn_paths))
    rows = (await db.execute(select(Image).where(or_(*conds)))).scalars().all()
    ids = [r.id for r in rows]
    from sqlalchemy import func
    counts: dict[str, int] = {}
    if ids:
        counts = dict((await db.execute(
            select(Tag.image_id, func.count()).where(Tag.image_id.in_(ids)).group_by(Tag.image_id)
        )).all())
    return {"items": [{
        "id": r.id, "cdn_path": r.cdn_path, "file_name": r.file_name,
        "review_status": r.review_status, "is_listed": bool(r.is_listed),
        "in_library": bool(r.in_library) if r.in_library is not None else None,
        "description": r.description, "tag_count": counts.get(r.id, 0),
        "width": r.width, "height": r.height,
    } for r in rows]}


@router.get("/image-brief/{image_id}", dependencies=[Depends(require_sync_token)])
async def image_brief(image_id: str, db: AsyncSession = Depends(get_db)):
    """单张云端图完整信息(含标签明细),桌面端 OSS 图库详情面板用。"""
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    tags = (await db.execute(select(Tag).where(Tag.image_id == image_id))).scalars().all()
    return {
        "id": img.id, "cdn_path": img.cdn_path, "file_name": img.file_name,
        "width": img.width, "height": img.height,
        "review_status": img.review_status, "is_listed": bool(img.is_listed),
        "description": img.description, "tag_status": img.tag_status,
        "tagged_at": _iso(img.tagged_at), "updated_at": _iso(img.updated_at),
        "tags": [{"dimension": t.dimension, "value": t.value,
                  "source": t.source, "confidence": t.confidence} for t in tags],
    }
