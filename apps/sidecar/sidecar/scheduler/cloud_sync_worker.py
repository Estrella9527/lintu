"""Local → cloud sync worker.

Drains the cloud_sync_jobs queue and POSTs batched events to the cloud
sidecar's /internal/sync/* endpoints. Durable: if the local app or network
goes down mid-flight, jobs stay `pending` and resume on next start.

Triggers (called from elsewhere in the codebase):
  - cloud_sync_worker.enqueue_image_upsert(image_id)
  - cloud_sync_worker.enqueue_image_delete(image_id)
  - cloud_sync_worker.enqueue_project_upsert(project_id)
  - cloud_sync_worker.enqueue_synonyms_replace()
  - cloud_sync_worker.enqueue_tag_schema_replace()
  - ... (one helper per entity_type / op pair)

Disabled (start() returns early) when LINTU_CLOUD_SYNC_URL is empty —
electron-only deployments don't need a cloud at all.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

import httpx
from sqlalchemy import select, update

from sidecar.config import LINTU_CLOUD_SYNC_URL, LINTU_INTERNAL_SYNC_TOKEN
from sidecar.db.models import ApiKey, CloudSyncJob, Image, Project, Tag
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)


# ── Tunables (env-overridable) ─────────────────────────────────────────────


_BATCH_SIZE = 50               # how many jobs of one entity_type per HTTP call
_TICK_INTERVAL = 30.0          # seconds between drain cycles
_MAX_ATTEMPTS = 6              # retry budget before marking failed
_HTTP_TIMEOUT = httpx.Timeout(connect=10, read=60, write=60, pool=10)


# ── Public enqueue API ──────────────────────────────────────────────────────


async def _enqueue(entity_type: str, entity_id: str | None, op: str) -> None:
    """De-dupe by (entity_type, entity_id, status='pending'). Multiple writes
    to the same row in quick succession collapse into one sync push.

    Also pokes the worker so we don't wait the full _TICK_INTERVAL for the
    next sweep — typical sync latency drops from 30s to <1s."""
    if not LINTU_CLOUD_SYNC_URL:
        return  # cloud sync disabled
    async with async_session() as db:
        existing = (await db.execute(
            select(CloudSyncJob)
            .where(CloudSyncJob.entity_type == entity_type)
            .where(CloudSyncJob.entity_id == entity_id)
            .where(CloudSyncJob.status == "pending")
            .limit(1)
        )).scalar_one_or_none()
        if existing:
            # Already queued; later op wins (a delete after upsert overrides).
            if existing.op != op:
                existing.op = op
                existing.updated_at = datetime.utcnow()
            await db.commit()
        else:
            db.add(CloudSyncJob(
                entity_type=entity_type, entity_id=entity_id, op=op,
                created_at=datetime.utcnow(), updated_at=datetime.utcnow(),
            ))
            await db.commit()
    # Wake the worker so newly-enqueued events propagate immediately.
    cloud_sync_worker.wakeup()


async def enqueue_image_upsert(image_id: str) -> None:
    await _enqueue("image", image_id, "upsert")


async def enqueue_image_delete(image_id: str) -> None:
    await _enqueue("image", image_id, "delete")


async def enqueue_project_upsert(project_id: str) -> None:
    await _enqueue("project", project_id, "upsert")


async def enqueue_project_delete(project_id: str) -> None:
    await _enqueue("project", project_id, "delete")


async def enqueue_api_key_upsert(api_key_id: str) -> None:
    await _enqueue("api_key", api_key_id, "upsert")


async def enqueue_api_key_delete(api_key_id: str) -> None:
    await _enqueue("api_key", api_key_id, "delete")


async def enqueue_synonyms_replace() -> None:
    await _enqueue("synonyms", None, "upsert")


async def enqueue_tag_schema_replace() -> None:
    await _enqueue("tag_schema", None, "upsert")


async def enqueue_config_replace() -> None:
    """Push the cloud-relevant subset of config.json to cloud's settings.
    Called from /api/config PUT so operator-tuned defaults (match strategy
    knobs etc) reach the cloud sidecar without a manual bulk-script run."""
    await _enqueue("config", None, "upsert")


# Keys that get pushed when config changes. Shared with sync_to_cloud_bulk.py
# so manual + automatic pushes stay consistent. NEVER include OSS write
# credentials (oss_access_key / oss_access_secret) — cloud is read-only.
CLOUD_RELEVANT_CONFIG_KEYS = (
    "default_image_embedding_provider",
    "image_embedding_model_override",
    "default_general_provider",
    "default_parser_provider",
    "general_provider_model",
    "parser_provider_model",
    "custom_relays",
    "match_strategy_weights",
    "match_max_limit",
    "match_default_strategy",
    "match_default_diversity",
    "match_default_randomness",
    "match_default_unique_per_source",
    "match_default_no_people",
    "match_recent_cooldown_size",
    "oss_provider",
    "oss_endpoint",
    "oss_bucket",
    "oss_cdn_base",
    "oss_signed_url_ttl_sec",
)


# ── Worker ─────────────────────────────────────────────────────────────────


class CloudSyncWorker:
    def __init__(self) -> None:
        self._stopped = False
        self._task: asyncio.Task | None = None
        self._wakeup = asyncio.Event()

    async def start(self) -> None:
        if not LINTU_CLOUD_SYNC_URL:
            logger.info("cloud_sync_worker: disabled (LINTU_CLOUD_SYNC_URL empty)")
            return
        if not LINTU_INTERNAL_SYNC_TOKEN:
            logger.warning("cloud_sync_worker: LINTU_CLOUD_SYNC_URL is set but LINTU_INTERNAL_SYNC_TOKEN is not — sync would fail. Disabled.")
            return
        # On startup, reset any 'running' rows back to 'pending' (we got
        # killed mid-flight last time).
        async with async_session() as db:
            await db.execute(
                update(CloudSyncJob)
                .where(CloudSyncJob.status == "running")
                .values(status="pending")
            )
            await db.commit()
        self._stopped = False
        self._task = asyncio.create_task(self._run())
        logger.info("cloud_sync_worker: started → %s", LINTU_CLOUD_SYNC_URL)

    async def stop(self) -> None:
        self._stopped = True
        self._wakeup.set()
        if self._task:
            self._task.cancel()
        logger.info("cloud_sync_worker: stopped")

    def wakeup(self) -> None:
        """Tell the worker to drain ASAP instead of waiting for next tick.
        Call after an enqueue if you want low latency on a specific event."""
        self._wakeup.set()

    async def _run(self) -> None:
        while not self._stopped:
            try:
                processed = await self._tick()
                if processed == 0:
                    try:
                        await asyncio.wait_for(self._wakeup.wait(), timeout=_TICK_INTERVAL)
                    except asyncio.TimeoutError:
                        pass
                    self._wakeup.clear()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("cloud_sync_worker tick error: %s", e)
                await asyncio.sleep(5)

    async def _tick(self) -> int:
        """Drain pending jobs grouped by entity_type, batch up, POST."""
        async with async_session() as db:
            jobs = (await db.execute(
                select(CloudSyncJob)
                .where(CloudSyncJob.status == "pending")
                .where(CloudSyncJob.attempts < _MAX_ATTEMPTS)
                .order_by(CloudSyncJob.created_at)
                .limit(_BATCH_SIZE * 5)  # pull up to 5 batches worth in one go
            )).scalars().all()
            if not jobs:
                return 0
            # Mark them running so a concurrent tick (shouldn't happen, but
            # safe) doesn't re-pick.
            ids = [j.id for j in jobs]
            await db.execute(
                update(CloudSyncJob).where(CloudSyncJob.id.in_(ids))
                .values(status="running", updated_at=datetime.utcnow())
            )
            await db.commit()

        # Group by (entity_type, op) so we can batch each call
        groups: dict[tuple[str, str], list[CloudSyncJob]] = {}
        for j in jobs:
            groups.setdefault((j.entity_type, j.op), []).append(j)

        processed = 0
        # When the cloud URL is loopback (typically e2e local test), force
        # bypassing any system proxy — macOS Clash / corp proxies sometimes
        # intercept 127.0.0.1 despite the exception list.
        client_kwargs: dict = {
            "timeout": _HTTP_TIMEOUT,
            "headers": {"Authorization": f"Bearer {LINTU_INTERNAL_SYNC_TOKEN}"},
        }
        if any(h in LINTU_CLOUD_SYNC_URL for h in ("127.0.0.1", "localhost", "::1")):
            client_kwargs["proxy"] = None
            client_kwargs["trust_env"] = False
        async with httpx.AsyncClient(**client_kwargs) as client:
            for (etype, op), group in groups.items():
                # batch into chunks of _BATCH_SIZE
                for i in range(0, len(group), _BATCH_SIZE):
                    chunk = group[i:i + _BATCH_SIZE]
                    try:
                        await self._send_chunk(client, etype, op, chunk)
                        await self._mark_done([j.id for j in chunk])
                        processed += len(chunk)
                    except Exception as e:
                        logger.warning("cloud_sync %s/%s chunk failed: %s", etype, op, e)
                        await self._mark_failed_attempt([j.id for j in chunk], str(e)[:500])
        return processed

    async def _send_chunk(
        self,
        client: httpx.AsyncClient,
        entity_type: str,
        op: str,
        chunk: list[CloudSyncJob],
    ) -> None:
        url_base = LINTU_CLOUD_SYNC_URL.rstrip("/")
        ids = [j.entity_id for j in chunk if j.entity_id]

        if op == "upsert":
            if entity_type == "image":
                payload = await self._build_images_payload(ids)
                await self._post(client, f"{url_base}/internal/sync/images", payload)
            elif entity_type == "project":
                payload = await self._build_projects_payload(ids)
                await self._post(client, f"{url_base}/internal/sync/projects", payload)
            elif entity_type == "api_key":
                payload = await self._build_api_keys_payload(ids)
                await self._post(client, f"{url_base}/internal/sync/api-keys", payload)
            elif entity_type == "synonyms":
                payload = self._build_synonyms_payload()
                await self._post(client, f"{url_base}/internal/sync/synonyms", payload)
            elif entity_type == "tag_schema":
                payload = self._build_tag_schema_payload()
                await self._post(client, f"{url_base}/internal/sync/tag-schema", payload)
            elif entity_type == "config":
                payload = self._build_config_payload()
                if payload["settings"]:
                    await self._post(client, f"{url_base}/internal/sync/config", payload)
            else:
                raise ValueError(f"unknown entity_type for upsert: {entity_type}")
        elif op == "delete":
            payload = {entity_type + "s": ids}  # 'image' → 'images'
            # /deletes endpoint accepts mixed: {"images":[...], "projects":[...], "api_keys":[...]}
            await self._post(client, f"{url_base}/internal/sync/deletes", payload)
        else:
            raise ValueError(f"unknown op: {op}")

    @staticmethod
    async def _post(client: httpx.AsyncClient, url: str, payload: dict) -> None:
        resp = await client.post(url, json=payload)
        if resp.status_code >= 400:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")

    async def _build_images_payload(self, ids: list[str]) -> dict:
        from sidecar.engines.clip_embed import deserialize_vector
        async with async_session() as db:
            imgs = (await db.execute(select(Image).where(Image.id.in_(ids)))).scalars().all()
            tag_rows = (await db.execute(
                select(Tag.image_id, Tag.dimension, Tag.value, Tag.source, Tag.confidence)
                .where(Tag.image_id.in_(ids))
            )).all()
        tags_by_img: dict[str, list[dict]] = {}
        for img_id, dim, val, src, conf in tag_rows:
            tags_by_img.setdefault(img_id, []).append({
                "dimension": dim, "value": val, "source": src, "confidence": conf,
            })
        out = {"images": []}
        for img in imgs:
            # Embedding is stored as base64-float16 text (clip_embed format),
            # not raw bytes. Decode to float32 list for transport.
            emb_arr = deserialize_vector(img.embedding) if img.embedding else None
            emb = emb_arr.tolist() if emb_arr is not None else None
            out["images"].append({
                "id": img.id,
                "project_id": img.project_id,
                "file_path": img.file_path,
                "file_name": img.file_name,
                "file_hash": img.file_hash,
                "phash": img.phash,
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
                "relative_dir": img.relative_dir,
                "parent_id": img.parent_id,
                "rotated_file_path": img.rotated_file_path,
                "orient_status": img.orient_status,
                "cdn_path": img.cdn_path,
                "embedding": emb,
                "embedding_model": img.embedding_model,
                "text_search_blob": img.text_search_blob,
                "generation_metadata": img.generation_metadata,
                "tagged_at": img.tagged_at.isoformat() if img.tagged_at else None,
                "tag_provider": img.tag_provider,
                "tags": tags_by_img.get(img.id, []),
            })
        return out

    async def _build_projects_payload(self, ids: list[str]) -> dict:
        async with async_session() as db:
            rows = (await db.execute(select(Project).where(Project.id.in_(ids)))).scalars().all()
        return {"projects": [
            {
                "id": p.id, "name": p.name,
                "originals_path": p.originals_path,
                "workspace_path": p.workspace_path,
                "color": p.color,
            } for p in rows
        ]}

    async def _build_api_keys_payload(self, ids: list[str]) -> dict:
        async with async_session() as db:
            rows = (await db.execute(select(ApiKey).where(ApiKey.id.in_(ids)))).scalars().all()
        return {"api_keys": [
            {
                "id": k.id,
                "key_id": k.key_id,
                "key_secret_hash": k.key_secret_hash,
                "name": k.name,
                "client_type": k.client_type,
                "allowed_origins": k.allowed_origins,
                "allowed_ips": k.allowed_ips,
                "scopes": k.scopes,
                "rate_limit": k.rate_limit,
                "expires_at": k.expires_at.isoformat() if k.expires_at else None,
                "is_active": k.is_active,
            } for k in rows
        ]}

    @staticmethod
    def _build_synonyms_payload() -> dict:
        from sidecar.routers.match_synonyms import SYNONYMS_FILE
        if not SYNONYMS_FILE.exists():
            return {"entries": {}, "version": 0}
        data = json.loads(SYNONYMS_FILE.read_text(encoding="utf-8"))
        return {
            "entries": data.get("entries") or {},
            "version": int(data.get("version") or 0),
        }

    @staticmethod
    def _build_tag_schema_payload() -> dict:
        from sidecar.routers.tag_schema import _read_schema
        return {"schema": _read_schema()}

    @staticmethod
    def _build_config_payload() -> dict:
        """Read local config.json, return only the cloud-relevant subset.
        OSS write credentials are explicitly excluded — see CLOUD_RELEVANT_CONFIG_KEYS."""
        from sidecar.defaults import CONFIG_FILE
        if not CONFIG_FILE.exists():
            return {"settings": {}}
        try:
            full = json.loads(CONFIG_FILE.read_text())
        except (OSError, json.JSONDecodeError):
            return {"settings": {}}
        subset = {k: full[k] for k in CLOUD_RELEVANT_CONFIG_KEYS if k in full}
        return {"settings": subset}

    async def _mark_done(self, ids: list[int]) -> None:
        async with async_session() as db:
            await db.execute(
                update(CloudSyncJob).where(CloudSyncJob.id.in_(ids))
                .values(status="done", updated_at=datetime.utcnow())
            )
            await db.commit()

    async def _mark_failed_attempt(self, ids: list[int], err: str) -> None:
        async with async_session() as db:
            jobs = (await db.execute(
                select(CloudSyncJob).where(CloudSyncJob.id.in_(ids))
            )).scalars().all()
            for j in jobs:
                j.attempts = (j.attempts or 0) + 1
                j.error = err
                j.updated_at = datetime.utcnow()
                if j.attempts >= _MAX_ATTEMPTS:
                    j.status = "failed"
                else:
                    j.status = "pending"  # retry on next tick (with backoff via _TICK_INTERVAL)
            await db.commit()


cloud_sync_worker = CloudSyncWorker()
