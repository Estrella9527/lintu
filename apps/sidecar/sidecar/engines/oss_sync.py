"""Object storage abstraction + Aliyun OSS implementation.

Why an abstraction:
  - Lets us swap to Tencent COS / Qiniu later without rewriting hooks
  - Tests can use an in-memory backend
  - Disabled state ("oss_provider" empty) is a first-class no-op rather than
    a try/except sprinkled across callers

Configuration is read from get_setting():
  oss_provider          ""(disabled) | "aliyun"
  oss_endpoint          e.g. "oss-cn-hangzhou.aliyuncs.com"
  oss_bucket            bucket name
  oss_access_key        access key id
  oss_access_secret     access key secret
  oss_cdn_base          "https://cdn.lintu.com" — used to build public URLs
                        falls back to the OSS endpoint when empty
  oss_signed_url_ttl_sec  0 (public bucket) or N (signed URL ttl)

Object key layout in the bucket:
  i/{id}.{ext}            — original full-resolution
  i/{id}_300.jpg          — 300px thumbnail
  i/{id}_800.jpg          — 800px thumbnail

This layout matches `cdn_path` semantics used by openapi_v1.image_payload.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional, Protocol

from sidecar.defaults import get_setting

logger = logging.getLogger(__name__)

AssetKind = Literal["original", "thumb_300", "thumb_800"]


@dataclass
class UploadResult:
    object_key: str
    public_url: str


class ObjectStorage(Protocol):
    def upload(self, *, object_key: str, local_path: str, content_type: str) -> UploadResult: ...
    def public_url(self, object_key: str) -> str: ...
    def is_configured(self) -> bool: ...


# ── Aliyun OSS ──────────────────────────────────────────────────────────────


class AliyunOSSStorage:
    """Lazy-init Aliyun OSS bucket. Constructor must NOT call network — we
    create the actual oss2.Bucket only at first use, then cache it."""

    def __init__(
        self,
        *,
        endpoint: str,
        bucket_name: str,
        access_key: str,
        access_secret: str,
        cdn_base: str = "",
        signed_ttl_sec: int = 0,
    ):
        self.endpoint = endpoint.rstrip("/")
        self.bucket_name = bucket_name
        self.access_key = access_key
        self.access_secret = access_secret
        self.cdn_base = cdn_base.rstrip("/")
        self.signed_ttl_sec = max(0, int(signed_ttl_sec or 0))
        self._bucket = None
        self._lock = threading.Lock()

    def is_configured(self) -> bool:
        return bool(self.endpoint and self.bucket_name and self.access_key and self.access_secret)

    def _ensure_bucket(self):
        if self._bucket is not None:
            return self._bucket
        with self._lock:
            if self._bucket is not None:
                return self._bucket
            import oss2  # lazy import — only loaded when first sync runs
            from requests.adapters import HTTPAdapter
            from urllib3.util.retry import Retry

            auth = oss2.Auth(self.access_key, self.access_secret)
            endpoint = self.endpoint
            if not endpoint.startswith("http"):
                endpoint = "https://" + endpoint

            # Custom session with an oversized connection pool + minimal
            # transport-level retries. Why these numbers:
            #
            # - pool_maxsize=64: under 16-way concurrency we want every worker
            #   to find a warm keep-alive socket waiting. Default 10 caused
            #   socket churn → repeated SSL handshakes → OSS rejected new
            #   connections that arrived too fast (UNEXPECTED_EOF).
            #
            # - retry total=1: urllib3 retries multiply latency (each adds
            #   backoff before the next attempt), and our OssSyncWorker has
            #   its own attempt loop with up to 8 tries, so a fast inner
            #   failure surfaces sooner and gets a clean retry from the
            #   worker (which can use a fresh socket from the pool).
            #
            # - max_retries.connect/read=1: same reasoning, fail fast.
            session = oss2.Session()
            retry = Retry(
                total=1,
                connect=1,
                read=1,
                backoff_factor=0.3,
                status_forcelist=[408, 429, 500, 502, 503, 504],
                allowed_methods=frozenset(["GET", "HEAD", "PUT", "POST", "DELETE"]),
                raise_on_status=False,
            )
            adapter = HTTPAdapter(
                pool_connections=64,
                pool_maxsize=64,
                max_retries=retry,
                pool_block=False,
            )
            session.session.mount("https://", adapter)
            session.session.mount("http://", adapter)

            # 5s connect / 30s read — fast fail on connect issues but tolerate
            # slow large-file reads. With keep-alive the connect step is a
            # no-op for warm sockets.
            self._bucket = oss2.Bucket(
                auth, endpoint, self.bucket_name,
                session=session,
                connect_timeout=5,
                app_name="lintu-sync",
            )
            return self._bucket

    def upload(self, *, object_key: str, local_path: str, content_type: str) -> UploadResult:
        bucket = self._ensure_bucket()
        headers = {"Content-Type": content_type, "Cache-Control": "public, max-age=2592000"}
        bucket.put_object_from_file(object_key, local_path, headers=headers)
        return UploadResult(object_key=object_key, public_url=self.public_url(object_key))

    def public_url(self, object_key: str) -> str:
        if self.signed_ttl_sec > 0:
            bucket = self._ensure_bucket()
            return bucket.sign_url("GET", object_key, self.signed_ttl_sec, slash_safe=True)
        if self.cdn_base:
            return f"{self.cdn_base}/{object_key}"
        # Fall back to the bucket's direct URL
        endpoint = self.endpoint
        if not endpoint.startswith("http"):
            endpoint = "https://" + endpoint
        return f"https://{self.bucket_name}.{endpoint.replace('https://', '').replace('http://', '')}/{object_key}"


# ── No-op (disabled) ────────────────────────────────────────────────────────


class NullStorage:
    def is_configured(self) -> bool:
        return False
    def upload(self, **_kwargs):  # pragma: no cover
        raise RuntimeError("OSS not configured")
    def public_url(self, object_key: str) -> str:  # pragma: no cover
        return ""


# ── Singleton resolver (rebuilt when config changes) ────────────────────────


_storage_cache: tuple[str, ObjectStorage] | None = None
_storage_lock = threading.Lock()


def get_storage() -> ObjectStorage:
    """Return the configured ObjectStorage. Cached by (provider, key fields)
    so config changes via /api/config rebuild it."""
    global _storage_cache
    provider = (get_setting("oss_provider") or "").lower()
    if not provider:
        return NullStorage()

    cache_key = "|".join([
        provider,
        get_setting("oss_endpoint") or "",
        get_setting("oss_bucket") or "",
        get_setting("oss_access_key") or "",
        # Don't include secret in cache key (it changes on rotate; rebuild OK)
        get_setting("oss_cdn_base") or "",
        str(get_setting("oss_signed_url_ttl_sec") or 0),
    ])

    with _storage_lock:
        if _storage_cache and _storage_cache[0] == cache_key:
            return _storage_cache[1]

        if provider == "aliyun":
            storage: ObjectStorage = AliyunOSSStorage(
                endpoint=get_setting("oss_endpoint") or "",
                bucket_name=get_setting("oss_bucket") or "",
                access_key=get_setting("oss_access_key") or "",
                access_secret=get_setting("oss_access_secret") or "",
                cdn_base=get_setting("oss_cdn_base") or "",
                signed_ttl_sec=int(get_setting("oss_signed_url_ttl_sec") or 0),
            )
        else:
            logger.warning("Unsupported oss_provider=%s; falling back to disabled", provider)
            storage = NullStorage()
        _storage_cache = (cache_key, storage)
        return storage


def invalidate_storage_cache() -> None:
    """Force the next get_storage() to rebuild. Call after PUT /api/config."""
    global _storage_cache
    with _storage_lock:
        _storage_cache = None


# ── Object key layout helpers ───────────────────────────────────────────────


def object_key_for(image_id: str, kind: AssetKind, ext: str) -> str:
    ext = ext.lstrip(".").lower() or "bin"
    if kind == "original":
        return f"i/{image_id}.{ext}"
    if kind == "thumb_300":
        return f"i/{image_id}_300.jpg"
    if kind == "thumb_800":
        return f"i/{image_id}_800.jpg"
    raise ValueError(f"unknown kind: {kind!r}")


def content_type_for_ext(ext: str) -> str:
    return {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "webp": "image/webp",
        "gif": "image/gif", "bmp": "image/bmp",
        "tif": "image/tiff", "tiff": "image/tiff",
        "heic": "image/heic", "heif": "image/heif",
    }.get(ext.lstrip(".").lower(), "application/octet-stream")


# ── Enqueue helpers (called from scan / batch_engine after a row commits) ──


async def enqueue_image_sync(image_id: str) -> int:
    """Enqueue 3 upload jobs (original + 300 + 800 thumbs) for an image.

    Idempotent: if a (image_id, asset_kind, status='pending'|'running'|'done')
    row already exists, that asset is skipped. Returns the number of NEW rows
    inserted.

    No-op when OSS is disabled — we don't want to fill the queue with rows
    that can't be drained.
    """
    storage = get_storage()
    if not storage.is_configured():
        return 0

    from sqlalchemy import select
    from sidecar.config import THUMBNAILS_DIR
    from sidecar.db.models import Image, OssSyncJob
    from sidecar.db.session import async_session
    from sidecar.engines.image_utils import effective_file_path
    from sidecar.engines.thumbnail import get_thumbnail_path

    async with async_session() as db:
        img = await db.get(Image, image_id)
        if not img:
            return 0

        existing = await db.execute(
            select(OssSyncJob.asset_kind)
            .where(OssSyncJob.image_id == image_id)
            .where(OssSyncJob.status.in_(["pending", "running", "done"]))
        )
        already = {r[0] for r in existing.all()}

        original_path = effective_file_path(img)
        original_ext = Path(original_path).suffix.lstrip(".").lower() or "jpg"

        plans: list[tuple[str, str, str, str]] = []  # (asset_kind, key, local, ctype)
        if "original" not in already:
            plans.append((
                "original",
                object_key_for(image_id, "original", original_ext),
                str(original_path),
                content_type_for_ext(original_ext),
            ))
        for size, kind in ((300, "thumb_300"), (800, "thumb_800")):
            if kind in already:
                continue
            local = get_thumbnail_path(image_id, size, THUMBNAILS_DIR)
            plans.append((
                kind,
                object_key_for(image_id, kind, "jpg"),  # thumbs are always JPEG
                str(local),
                "image/jpeg",
            ))

        for kind, key, local, ctype in plans:
            db.add(OssSyncJob(
                image_id=image_id,
                asset_kind=kind,
                object_key=key,
                local_path=local,
                content_type=ctype,
                status="pending",
            ))
        await db.commit()
        return len(plans)


async def enqueue_many(image_ids: list[str]) -> int:
    n = 0
    for iid in image_ids:
        try:
            n += await enqueue_image_sync(iid)
        except Exception as e:
            logger.warning("enqueue_image_sync(%s) failed: %s", iid, e)
    return n
