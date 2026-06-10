"""云端→本地拉取合并(方案A 多设备同步 · Phase 2)。

与 cloud_sync_worker(本地→云端 push)互补,本 worker 把**云端的变更拉回本地**,
让同一账号的多台桌面端看到同一份数据。云端权威:冲突按"云端 updated_at 更大者胜"
(Last-Write-Wins),本地直接被覆盖。

链路:
  - GET {LINTU_CLOUD_SYNC_URL}/internal/sync/changes?since=<cursor>
  - 返回 since 之后的 upsert(images/projects/api_keys/users/orgs/成员)+ deletes(墓碑)
  - 本 worker 把它们**直接写本地库**(不经 enqueue,避免回声把拉来的变更又推回云端)
  - 游标持久化到 DATA_DIR/cloud_pull_state.json,断点续拉

开关:LINTU_CLOUD_PULL=1 才启用(默认关 — 主控桌面端只 push;副设备显式开 pull)。

冷启动:游标为空 → 从头全量拉(分页,images 500/页),把云端整库灌进本地。
图片二进制不在此下载:本地按 cdn_path 懒加载 OSS 缩略图/原图;file_path 在新设备
上可能不存在,UI 回退用 cdn_path。

防回声:本 worker 全程直接 DB 写,不调用 enqueue_*,所以拉来的变更不会再被 push
回云端。onupdate 会把本地 updated_at 刷成本地时刻,但因不 enqueue,无副作用。
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

import httpx
from sqlalchemy import delete as sql_delete, select

from sidecar.config import (
    DATA_DIR, LINTU_CLOUD_PULL, LINTU_CLOUD_SYNC_URL, LINTU_INTERNAL_SYNC_TOKEN,
    LINTU_MODE,
)
from sidecar.db.models import (
    ApiKey, Image, Organization, OrganizationMember, Project, ProjectMember, Tag, User,
)
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)

_TICK_INTERVAL = 30.0
_STATE_FILE = DATA_DIR / "cloud_pull_state.json"
_HTTP_TIMEOUT = httpx.Timeout(connect=10, read=120, write=120, pool=10)


def _load_cursor() -> str:
    try:
        if _STATE_FILE.exists():
            return json.loads(_STATE_FILE.read_text()).get("cursor", "") or ""
    except Exception:
        logger.warning("cloud_pull: 读游标失败,从头拉", exc_info=True)
    return ""


def _save_state(cursor: str, last_counts: dict | None = None) -> None:
    """存游标 + 最近一次同步信息(设置页「多设备同步」状态展示用)。"""
    state: dict = {"cursor": cursor}
    try:
        if _STATE_FILE.exists():
            state = json.loads(_STATE_FILE.read_text()) or {}
        state["cursor"] = cursor
    except Exception:
        pass
    state["last_at"] = datetime.utcnow().isoformat()
    if last_counts:
        state["last_counts"] = last_counts
    try:
        _STATE_FILE.write_text(json.dumps(state, ensure_ascii=False))
    except Exception:
        logger.warning("cloud_pull: 存游标失败", exc_info=True)


def pull_status() -> dict:
    """给设置页用的状态快照:开关 + 上次同步时间/计数。"""
    from sidecar.defaults import get_setting
    enabled = LINTU_CLOUD_PULL or str(get_setting("cloud_pull_enabled") or "").lower() in ("1", "true", "yes")
    out = {"enabled": bool(enabled), "last_at": None, "last_counts": None, "cursor": ""}
    try:
        if _STATE_FILE.exists():
            st = json.loads(_STATE_FILE.read_text()) or {}
            out["last_at"] = st.get("last_at")
            out["last_counts"] = st.get("last_counts")
            out["cursor"] = st.get("cursor") or ""
    except Exception:
        pass
    return out


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


class CloudPullWorker:
    def __init__(self) -> None:
        self._stopped = False
        self._task: asyncio.Task | None = None

    @staticmethod
    def _enabled() -> bool:
        """env 强开(运维) 或 设置页开关 cloud_pull_enabled(每 tick 现读,改完即生效)。"""
        if LINTU_CLOUD_PULL:
            return True
        from sidecar.defaults import get_setting
        return str(get_setting("cloud_pull_enabled") or "").lower() in ("1", "true", "yes")

    async def start(self) -> None:
        # 云端(server 模式)永不拉自己;桌面端常驻 loop,开关由每 tick 判定。
        if LINTU_MODE != "electron":
            logger.info("cloud_pull_worker: server mode,不启动")
            return
        if not LINTU_CLOUD_SYNC_URL or not LINTU_INTERNAL_SYNC_TOKEN:
            logger.warning("cloud_pull_worker: 需要 LINTU_CLOUD_SYNC_URL + LINTU_INTERNAL_SYNC_TOKEN,已禁用")
            return
        self._stopped = False
        self._task = asyncio.create_task(self._run())
        logger.info("cloud_pull_worker: loop started ← %s (enabled=%s)",
                    LINTU_CLOUD_SYNC_URL, self._enabled())

    async def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
        logger.info("cloud_pull_worker: stopped")

    async def _run(self) -> None:
        from sidecar.db.tenant import enter_system_context
        enter_system_context()  # 直接写多表,绕过租户过滤
        headers = {"Authorization": f"Bearer {LINTU_INTERNAL_SYNC_TOKEN}"}
        url = f"{LINTU_CLOUD_SYNC_URL.rstrip('/')}/internal/sync/changes"
        while not self._stopped:
            try:
                # 设置页开关每 tick 现读:关 → 本轮跳过(改完即生效,无需重启)
                if self._enabled():
                    async with httpx.AsyncClient(headers=headers, timeout=_HTTP_TIMEOUT) as client:
                        await self._drain(client, url)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.warning("cloud_pull: 拉取循环异常", exc_info=True)
            try:
                await asyncio.sleep(_TICK_INTERVAL)
            except asyncio.CancelledError:
                break

    async def _drain(self, client: httpx.AsyncClient, url: str) -> None:
        """循环拉取直到 has_more=false(冷启动会连拉多页),逐页 apply + 存游标。"""
        cursor = _load_cursor()
        pages = 0
        while not self._stopped:
            resp = await client.get(url, params={"since": cursor} if cursor else {})
            if resp.status_code >= 400:
                logger.warning("cloud_pull: changes %s — %s", resp.status_code, resp.text[:200])
                return
            data = resp.json()
            applied = await self._apply(data)
            cursor = data.get("cursor") or cursor
            _save_state(cursor, applied)
            pages += 1
            if applied:
                logger.info("cloud_pull: 第%d页 apply %s, cursor=%s", pages, applied, cursor[:32])
            if not data.get("has_more"):
                break

    async def _apply(self, data: dict) -> dict:
        """把一页变更写入本地库。返回各类计数(便于日志)。"""
        counts = {"images": 0, "projects": 0, "api_keys": 0, "users": 0,
                  "orgs": 0, "org_members": 0, "project_members": 0, "deletes": 0}
        async with async_session() as db:
            # ── upserts ──
            await self._apply_projects(db, data.get("projects") or [], counts)
            await self._apply_users(db, data.get("users") or [], counts)
            await self._apply_orgs(db, data.get("orgs") or [], counts)
            await self._apply_org_members(db, data.get("org_members") or [], counts)
            await self._apply_project_members(db, data.get("project_members") or [], counts)
            await self._apply_api_keys(db, data.get("api_keys") or [], counts)
            await self._apply_images(db, data.get("images") or [], counts)
            # ── deletes(墓碑)──
            await self._apply_deletes(db, data.get("deletes") or {}, counts)
            await db.commit()
        # 删/改后让匹配索引重建
        try:
            from sidecar.engines.text_search import index_cache
            index_cache.invalidate(None)
        except Exception:
            pass
        return {k: v for k, v in counts.items() if v}

    async def _apply_projects(self, db, rows, counts):
        for p in rows:
            existing = await db.get(Project, p["id"])
            fields = dict(name=p.get("name"), originals_path=p.get("originals_path"),
                          workspace_path=p.get("workspace_path"), color=p.get("color"),
                          org_id=p.get("org_id"))
            if existing:
                for k, v in fields.items():
                    setattr(existing, k, v)
            else:
                db.add(Project(id=p["id"], **fields))
            counts["projects"] += 1

    async def _apply_users(self, db, rows, counts):
        for u in rows:
            existing = await db.get(User, u["id"])
            fields = dict(phone=u.get("phone"), display_name=u.get("display_name"),
                          avatar_url=u.get("avatar_url"), status=u.get("status") or "active",
                          is_root=u.get("is_root", False),
                          is_platform_owner=u.get("is_platform_owner", False))
            if existing:
                for k, v in fields.items():
                    setattr(existing, k, v)
            else:
                db.add(User(id=u["id"], **fields))
            counts["users"] += 1

    async def _apply_orgs(self, db, rows, counts):
        for o in rows:
            existing = await db.get(Organization, o["id"])
            fields = dict(name=o.get("name"), slug=o.get("slug"), logo_url=o.get("logo_url"),
                          contact_email=o.get("contact_email"), plan=o.get("plan") or "free",
                          storage_quota_gb=o.get("storage_quota_gb") or 10,
                          status=o.get("status") or "active")
            if existing:
                for k, v in fields.items():
                    setattr(existing, k, v)
            else:
                db.add(Organization(id=o["id"], **fields))
            counts["orgs"] += 1

    async def _apply_org_members(self, db, rows, counts):
        for m in rows:
            existing = await db.get(OrganizationMember, m["id"])
            fields = dict(org_id=m.get("org_id"), user_id=m.get("user_id"),
                          role=m.get("role") or "member", invited_by=m.get("invited_by"))
            if existing:
                for k, v in fields.items():
                    setattr(existing, k, v)
            else:
                db.add(OrganizationMember(id=m["id"], **fields))
            counts["org_members"] += 1

    async def _apply_project_members(self, db, rows, counts):
        for m in rows:
            existing = await db.get(ProjectMember, m["id"])
            fields = dict(project_id=m.get("project_id"), user_id=m.get("user_id"),
                          role=m.get("role") or "editor", invited_by=m.get("invited_by"))
            if existing:
                for k, v in fields.items():
                    setattr(existing, k, v)
            else:
                db.add(ProjectMember(id=m["id"], **fields))
            counts["project_members"] += 1

    async def _apply_api_keys(self, db, rows, counts):
        for k in rows:
            existing = await db.get(ApiKey, k["id"])
            fields = dict(key_id=k.get("key_id"), key_secret_hash=k.get("key_secret_hash"),
                          name=k.get("name"), client_type=k.get("client_type"),
                          allowed_origins=k.get("allowed_origins"), allowed_ips=k.get("allowed_ips"),
                          scopes=k.get("scopes"), rate_limit=k.get("rate_limit"),
                          expires_at=_parse_dt(k.get("expires_at")), is_active=k.get("is_active", True))
            if existing:
                for f, v in fields.items():
                    setattr(existing, f, v)
            else:
                db.add(ApiKey(id=k["id"], **fields))
            counts["api_keys"] += 1

    async def _apply_images(self, db, rows, counts):
        if not rows:
            return
        from sidecar.engines.clip_embed import serialize_vector
        import numpy as np
        ids = [it["id"] for it in rows]
        # 整批替换 tags(与云端 receiver 同策略)
        await db.execute(sql_delete(Tag).where(Tag.image_id.in_(ids)))
        for it in rows:
            emb = it.get("embedding")
            emb_text = serialize_vector(np.asarray(emb, dtype=np.float32)) if emb else None
            fields = {
                "project_id": it.get("project_id"), "file_path": it.get("file_path"),
                "file_name": it.get("file_name"), "file_hash": it.get("file_hash"),
                "phash": it.get("phash"), "file_size_kb": it.get("file_size_kb"),
                "width": it.get("width"), "height": it.get("height"),
                "blur_score": it.get("blur_score"), "brightness": it.get("brightness"),
                "quality_status": it.get("quality_status"), "reject_reason": it.get("reject_reason"),
                "is_kept": it.get("is_kept", True), "tag_status": it.get("tag_status"),
                "description": it.get("description"), "source_type": it.get("source_type"),
                "relative_dir": it.get("relative_dir"), "parent_id": it.get("parent_id"),
                "rotated_file_path": it.get("rotated_file_path"), "orient_status": it.get("orient_status"),
                "cdn_path": it.get("cdn_path"), "embedding": emb_text,
                "embedding_model": it.get("embedding_model"),
                "text_search_blob": it.get("text_search_blob"),
                "generation_metadata": it.get("generation_metadata"),
                "tagged_at": _parse_dt(it.get("tagged_at")), "tag_provider": it.get("tag_provider"),
            }
            # 协作状态三件套:老云端 feed 不带(None)时不覆盖本地值
            if it.get("review_status") is not None:
                fields["review_status"] = it["review_status"]
            if it.get("is_listed") is not None:
                fields["is_listed"] = it["is_listed"]
            if it.get("in_library") is not None:
                fields["in_library"] = it["in_library"]
            existing = await db.get(Image, it["id"])
            if existing:
                for k, v in fields.items():
                    setattr(existing, k, v)
            else:
                db.add(Image(id=it["id"], **fields))
            for t in it.get("tags") or []:
                db.add(Tag(image_id=it["id"], dimension=t.get("dimension"), value=t.get("value"),
                           source=t.get("source") or "ai", confidence=t.get("confidence")))
            counts["images"] += 1

    async def _apply_deletes(self, db, deletes: dict, counts):
        # deletes: {"images":[ids], "projects":[...], "users":[...], ...}
        img_ids = deletes.get("images") or []
        if img_ids:
            await db.execute(sql_delete(Tag).where(Tag.image_id.in_(img_ids)))
            await db.execute(sql_delete(Image).where(Image.id.in_(img_ids)))
            counts["deletes"] += len(img_ids)
        for key, model in (("project_members", ProjectMember), ("org_members", OrganizationMember),
                           ("api_keys", ApiKey), ("projects", Project),
                           ("orgs", Organization), ("users", User)):
            ids = deletes.get(key) or []
            if ids:
                await db.execute(sql_delete(model).where(model.id.in_(ids)))
                counts["deletes"] += len(ids)


cloud_pull_worker = CloudPullWorker()
