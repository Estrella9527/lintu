"""Background worker that drains oss_sync_jobs to the configured object store.

Lifecycle: started in main.py lifespan alongside BatchScheduler / TaskScheduler.
The worker loop runs forever; when OSS is disabled (or no pending jobs) it
sleeps quietly. When pending jobs exist, it pulls a small batch, uploads
each, and updates Image.cdn_path on success.

Failure handling:
  - Network/credential errors → bump attempts, leave row pending
  - attempts ≥ MAX_ATTEMPTS → status='failed', record last_error
  - Missing local file (e.g. thumb not yet generated) → lazily generate
    via thumbnail engine, retry. If still missing → status='skipped'
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from pathlib import Path

from sqlalchemy import select, update

from sidecar.config import THUMBNAILS_DIR
from sidecar.db.models import Image, OssSyncJob
from sidecar.db.session import async_session
from sidecar.engines.oss_sync import get_storage
from sidecar.engines.thumbnail import generate_thumbnail
from sidecar.engines.image_utils import effective_file_path

logger = logging.getLogger(__name__)

POLL_INTERVAL_SEC = 3
BATCH_SIZE = 96                # how many we pull from the queue per tick
UPLOAD_CONCURRENCY = 16        # parallel oss2 uploads. With pool_maxsize=64
                               # in the shared requests.Session, every worker
                               # finds a warm keep-alive socket — we trade
                               # naive concurrency (which triggers OSS RST
                               # storms) for "high concurrency on a primed
                               # connection pool" (which doesn't).
MAX_ATTEMPTS = 8               # SSL EOF errors are usually transient — give
                               # them more chances before giving up. Inner
                               # urllib3 retry is now 1 (fail-fast), so each
                               # outer attempt is a fresh socket from the
                               # pool rather than the same poisoned one.


class OssSyncWorker:
    def __init__(self):
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if self._task is not None:
            return
        # Recover from previous run: any rows still "running" are orphans
        # left by a process kill / crash. Reset them so this worker can
        # pick them back up.
        async with async_session() as db:
            res = await db.execute(
                update(OssSyncJob)
                .where(OssSyncJob.status == "running")
                .values(status="pending", last_error=None)
            )
            recovered = res.rowcount or 0
            await db.commit()
        if recovered:
            logger.info("OssSyncWorker: recovered %d orphaned running jobs", recovered)

        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="oss-sync-worker")
        logger.info("OssSyncWorker started")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _run(self) -> None:
        from sidecar.db.tenant import enter_system_context
        enter_system_context()  # OSS 队列是全局的,显式进入系统上下文(见 tenant.py)
        while not self._stop.is_set():
            try:
                processed = await self._tick()
            except Exception:
                logger.exception("OssSyncWorker tick crashed")
                processed = 0
            # Idle sleep when nothing to do; tighter loop when actively draining
            await asyncio.sleep(0.5 if processed > 0 else POLL_INTERVAL_SEC)

    async def _tick(self) -> int:
        storage = get_storage()
        if not storage.is_configured():
            return 0

        async with async_session() as db:
            rows = await db.execute(
                select(OssSyncJob)
                .where(OssSyncJob.status == "pending")
                .where(OssSyncJob.attempts < MAX_ATTEMPTS)
                .order_by(OssSyncJob.created_at.asc())
                .limit(BATCH_SIZE)
            )
            jobs = list(rows.scalars().all())
            if not jobs:
                return 0
            # Mark running so concurrent workers (future) don't double-pick
            ids = [j.id for j in jobs]
            await db.execute(
                update(OssSyncJob).where(OssSyncJob.id.in_(ids)).values(status="running")
            )
            await db.commit()

        # Process the batch with bounded concurrency. oss2 uploads each take
        # 0.5-2s (blocking I/O run in thread executor), so 8-way concurrency
        # gives ~4-15× the throughput of serial — without saturating the
        # default executor's thread pool (40 threads) or the Python GIL.
        sem = asyncio.Semaphore(UPLOAD_CONCURRENCY)

        async def guarded(job):
            async with sem:
                try:
                    await self._process_one(job, storage)
                except Exception as e:
                    # _process_one 内部已捕获常规上传异常并 _record_attempt;
                    # 这里兜住它没料到的异常(如 DB 锁、取消),避免一个 job 崩溃
                    # 把整批 gather 拖垮、让其余 job 卡在 running 永不恢复。
                    logger.warning("oss job %s 处理异常,记一次尝试: %s", job.id, e)
                    try:
                        await self._record_attempt(job, f"unexpected: {e}")
                    except Exception:
                        logger.exception("oss job %s record_attempt 也失败", job.id)

        # return_exceptions=True:即便 guarded 仍漏了某个异常,也不会取消其余 job。
        await asyncio.gather(*(guarded(j) for j in jobs), return_exceptions=True)
        return len(jobs)

    async def _process_one(self, job: OssSyncJob, storage) -> None:
        local = Path(job.local_path)
        # If a thumb is missing, try to generate it from the source image.
        if not local.exists() and job.asset_kind in ("thumb_300", "thumb_800"):
            await self._lazy_generate_thumb(job)
            local = Path(job.local_path)

        if not local.exists():
            await self._mark_failed(job, "local file missing")
            return

        try:
            # Use a thread executor — oss2 is blocking
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None,
                lambda: storage.upload(
                    object_key=job.object_key,
                    local_path=str(local),
                    content_type=job.content_type,
                ),
            )
        except Exception as e:
            await self._record_attempt(job, str(e))
            return

        # Success — mark done, and stamp cdn_path on the original image so the
        # Open API can hand out CDN URLs. For thumbs, cdn_path points to the
        # original; readers compute thumb URL from object_key naming convention.
        async with async_session() as db:
            await db.execute(
                update(OssSyncJob)
                .where(OssSyncJob.id == job.id)
                .values(status="done", completed_at=datetime.utcnow(), last_error=None)
            )
            if job.asset_kind == "original":
                await db.execute(
                    update(Image).where(Image.id == job.image_id).values(cdn_path=job.object_key)
                )
            await db.commit()

        # Once the original is on OSS, the image is "ready for cloud" — push
        # its metadata + embedding + tags to the cloud sidecar so UGC's
        # /match can return it. Cloud sync is a no-op when LINTU_CLOUD_SYNC_URL
        # is unset (pure local mode).
        if job.asset_kind == "original":
            try:
                from sidecar.scheduler.cloud_sync_worker import enqueue_image_upsert
                await enqueue_image_upsert(job.image_id)
            except Exception as e:
                logger.debug("cloud_sync enqueue failed (non-fatal): %s", e)

    async def _lazy_generate_thumb(self, job: OssSyncJob) -> None:
        """If a thumbnail file doesn't exist on disk, generate it now from the
        source image. This happens when an image is uploaded but the thumb
        size hasn't been requested by the UI yet."""
        try:
            async with async_session() as db:
                img = await db.get(Image, job.image_id)
                if not img:
                    return
                source = effective_file_path(img)
            size = 300 if job.asset_kind == "thumb_300" else 800
            thumb_path = Path(job.local_path)
            generate_thumbnail(source, thumb_path, size)
        except Exception as e:
            logger.warning("lazy thumb gen failed for %s/%s: %s", job.image_id, job.asset_kind, e)

    async def _record_attempt(self, job: OssSyncJob, error: str) -> None:
        async with async_session() as db:
            await db.execute(
                update(OssSyncJob)
                .where(OssSyncJob.id == job.id)
                .values(
                    status="pending" if job.attempts + 1 < MAX_ATTEMPTS else "failed",
                    attempts=job.attempts + 1,
                    last_error=error[:500],
                )
            )
            await db.commit()
        logger.warning("OSS upload attempt %d failed for %s/%s: %s",
                       job.attempts + 1, job.image_id, job.asset_kind, error[:200])

    async def _mark_failed(self, job: OssSyncJob, reason: str) -> None:
        async with async_session() as db:
            await db.execute(
                update(OssSyncJob)
                .where(OssSyncJob.id == job.id)
                .values(status="failed", last_error=reason, completed_at=datetime.utcnow())
            )
            await db.commit()


oss_worker = OssSyncWorker()
