"""BatchScheduler — drives 200-seed × 60-prompt production runs.

Architecture:
  - One BatchScheduler singleton, started/stopped via FastAPI lifespan.
  - Each running batch has an in-memory `BatchState` holding control events
    (pause/cancel) and a worker pool of `concurrency` coroutines.
  - Subtasks are persisted to `batch_subtasks` in 200-row chunks (lazy creation
    saves the all-12000-rows-in-one-INSERT problem).
  - Workers pop pending subtask ids from a queue, run them through
    GenerationPipeline, save the output image, update DB rows, refresh
    Prompt.stats, and check the budget envelope.

The pipeline (S2.1) is stateless and reused — this module owns scheduling
and persistence only.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image as PILImage
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import BatchRun, BatchSubtask, Image, Prompt, Task
from sidecar.db.session import async_session
from sidecar.engines.generation_pipeline import pipeline
from sidecar.engines.image_utils import detect_image_extension, effective_file_path, save_image_bytes
from sidecar.providers.base import PermanentError, ProviderError, TransientError

logger = logging.getLogger(__name__)

CHUNK_SIZE = 200
GENERATED_DIR = WORKSPACE_DIR / "generated" / "batch"
GENERATED_DIR.mkdir(parents=True, exist_ok=True)


def _safe_slug(text: str, max_len: int = 24) -> str:
    """Make a filesystem-safe filename slug from a Chinese / mixed string.

    Keeps Chinese characters, letters, digits, hyphens, underscores. Strips
    everything else; collapses runs of separators; caps length.
    """
    cleaned = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", (text or "").strip(), flags=re.UNICODE)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    if not cleaned:
        cleaned = "untitled"
    return cleaned[:max_len]


def _build_output_path(
    *,
    batch_name: str,
    seed_relative_dir: str,
    seed_filename: str,
    prompt_name: str,
    subtask_id: str,
    extension: str = "bin",
) -> Path:
    """Compose a sortable, human-readable filename inside per-batch folder.

    Layout:
        workspace/generated/batch/<batch-slug>/<seed-relative-dir>/
            <seed-stem>__<prompt-slug>__<id8>.<ext>

    Extension comes from the API response byte signature (png/jpg/webp). We
    don't pre-assume jpg — writing PNG bytes to a .jpg file would mislead
    tools that trust the extension.
    """
    batch_slug = _safe_slug(batch_name, 32) or "batch"
    prompt_slug = _safe_slug(prompt_name, 24) or "prompt"
    seed_stem = Path(seed_filename or "seed").stem[:24]
    short_id = subtask_id.replace("-", "")[:8]

    base = GENERATED_DIR / batch_slug
    if seed_relative_dir:
        base = base / seed_relative_dir
    base.mkdir(parents=True, exist_ok=True)
    ext = (extension or "bin").lstrip(".") or "bin"
    return base / f"{seed_stem}__{prompt_slug}__{short_id}.{ext}"


CIRCUIT_BREAKER_AUTH_FAILURES = 3   # consecutive 401/403 → pause whole batch


class BatchState:
    """Per-running-batch in-memory control + counters."""

    def __init__(self, batch_id: str, concurrency: int, max_retry: int, budget_usd: float | None):
        self.batch_id = batch_id
        self.concurrency = max(1, concurrency)
        self.max_retry = max(0, max_retry)
        self.budget_usd = budget_usd
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.paused = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.cost_usd = 0.0
        self.completed = 0
        self.failed = 0
        self.skipped = 0
        self.total = 0
        self.lock = asyncio.Lock()
        self.workers: list[asyncio.Task] = []
        self.producer: asyncio.Task | None = None
        self.progress_queue: asyncio.Queue = asyncio.Queue()
        # Circuit breaker — count consecutive auth-style failures. If we hit
        # CIRCUIT_BREAKER_AUTH_FAILURES in a row we pause the batch so the
        # operator can fix the provider before more credits drain.
        self.consecutive_auth_failures = 0
        self.circuit_tripped = False


class BatchScheduler:
    def __init__(self):
        self.states: dict[str, BatchState] = {}
        self._stopped = False

    # ── Lifecycle ──

    async def start(self) -> None:
        self._stopped = False
        # Recover any batches that were marked running when the process died
        async with async_session() as db:
            await db.execute(
                update(BatchRun)
                .where(BatchRun.status == "running")
                .values(status="paused")
            )
            await db.commit()
        logger.info("BatchScheduler started")

    async def stop(self) -> None:
        self._stopped = True
        for state in list(self.states.values()):
            state.cancelled.set()
            for w in state.workers:
                w.cancel()
            if state.producer:
                state.producer.cancel()
        self.states.clear()
        logger.info("BatchScheduler stopped")

    # ── Public control plane ──

    async def start_batch(self, batch_id: str) -> dict:
        if batch_id in self.states:
            return {"status": "already_running"}

        async with async_session() as db:
            batch = await db.get(BatchRun, batch_id)
            if not batch:
                raise ValueError(f"Batch {batch_id} not found")
            if batch.status not in ("pending", "paused", "failed"):
                raise ValueError(f"Batch is in status {batch.status}, cannot start")

            seed_ids = batch.seed_image_ids or []
            prompt_ids = batch.prompt_ids or []
            if not seed_ids or not prompt_ids:
                raise ValueError("Batch has no seeds or prompts")

            await db.execute(
                update(BatchRun)
                .where(BatchRun.id == batch_id)
                .values(
                    status="running",
                    started_at=datetime.utcnow(),
                    total=len(seed_ids) * len(prompt_ids),
                )
            )
            await db.commit()
            await db.refresh(batch)

        state = BatchState(
            batch_id=batch_id,
            concurrency=batch.concurrency or 10,
            max_retry=batch.max_retry or 3,
            budget_usd=float(batch.budget_usd) if batch.budget_usd is not None else None,
        )
        state.total = len(seed_ids) * len(prompt_ids)
        self.states[batch_id] = state

        await self._restore_counters(state)

        state.producer = asyncio.create_task(
            self._produce_subtasks(batch_id, seed_ids, prompt_ids, state)
        )
        state.workers = [
            asyncio.create_task(self._worker(batch_id, state, batch.provider_chain))
            for _ in range(state.concurrency)
        ]
        await self._push(state, {"event": "started", "total": state.total})
        return {"status": "started", "total": state.total}

    async def pause_batch(self, batch_id: str) -> dict:
        state = self.states.get(batch_id)
        if not state:
            await self._set_batch_status(batch_id, "paused")
            return {"status": "paused"}
        state.paused.set()
        await self._set_batch_status(batch_id, "paused")
        await self._push(state, {"event": "paused"})
        return {"status": "paused"}

    async def resume_batch(self, batch_id: str) -> dict:
        if batch_id in self.states:
            state = self.states[batch_id]
            state.paused.clear()
            await self._set_batch_status(batch_id, "running")
            await self._push(state, {"event": "resumed"})
            return {"status": "running"}
        # Not in memory — restart from DB state
        return await self.start_batch(batch_id)

    async def cancel_batch(self, batch_id: str) -> dict:
        state = self.states.pop(batch_id, None)
        if state:
            state.cancelled.set()
            for w in state.workers:
                w.cancel()
            if state.producer:
                state.producer.cancel()
            await self._push(state, {"event": "cancelled"})
        # Sweep any in-flight subtasks so the UI doesn't show "running" forever
        # (cancelled asyncio tasks can't update the DB if they were mid-await
        # on an httpx request that's hanging).
        async with async_session() as db:
            await db.execute(
                update(BatchSubtask)
                .where(BatchSubtask.batch_id == batch_id)
                .where(BatchSubtask.status.in_(["running", "retrying", "pending"]))
                .values(
                    status="cancelled",
                    completed_at=datetime.utcnow(),
                    error_message="batch cancelled",
                )
            )
            await db.commit()
        await self._set_batch_status(batch_id, "cancelled", set_completed_at=True)
        return {"status": "cancelled"}

    async def cancel_subtasks(
        self,
        batch_id: str,
        *,
        prompt_id: str | None = None,
        seed_image_id: str | None = None,
    ) -> dict:
        """Cancel a subset of subtasks within a (possibly running) batch.

        Pass exactly one of prompt_id / seed_image_id. Subtasks in
        pending/retrying/running for that subset are flipped to cancelled —
        success/failed/cancelled stay as-is so the batch's account remains
        truthful. Workers currently mid-call on a cancelled row will still
        finish their HTTP roundtrip; their result is then dropped via the
        DB status check in _run_subtask. Counters in memory are bumped to
        keep finalize math consistent.
        """
        if not (bool(prompt_id) ^ bool(seed_image_id)):
            raise ValueError("Pass exactly one of prompt_id or seed_image_id")

        filters = [BatchSubtask.batch_id == batch_id]
        if prompt_id:
            filters.append(BatchSubtask.prompt_id == prompt_id)
        else:
            filters.append(BatchSubtask.seed_image_id == seed_image_id)

        async with async_session() as db:
            rows = await db.execute(
                select(BatchSubtask.id, BatchSubtask.status)
                .where(*filters)
                .where(BatchSubtask.status.in_(["pending", "retrying", "running"]))
            )
            target = rows.all()
            if not target:
                return {"status": "noop", "cancelled": 0}

            await db.execute(
                update(BatchSubtask)
                .where(BatchSubtask.id.in_([r[0] for r in target]))
                .values(
                    status="cancelled",
                    completed_at=datetime.utcnow(),
                    error_message="cancelled by user",
                )
            )
            await db.commit()

        n = len(target)
        state = self.states.get(batch_id)
        if state:
            async with state.lock:
                state.skipped += n  # account for them in finalize math
                state.total = max(state.total, state.completed + state.failed + state.skipped)
            await self._push(state, {
                "event": "subset_cancelled",
                "scope": "prompt" if prompt_id else "seed",
                "key": prompt_id or seed_image_id,
                "count": n,
                **self._counters(state),
            })
            await self._maybe_finalize(batch_id, state)
        else:
            # Batch already finalized — keep its terminal status, just rewrite
            # the row counts (sync_batch_counters reads DB).
            await self._sync_batch_counters_from_db(batch_id)

        return {"status": "ok", "cancelled": n}

    async def _sync_batch_counters_from_db(self, batch_id: str) -> None:
        """Recompute BatchRun.completed/failed/skipped from current rows.

        Used after a subset cancel on a finalized batch so the per-batch
        counters in the list view stay accurate.
        """
        async with async_session() as db:
            counts = await db.execute(
                select(BatchSubtask.status, func.count(BatchSubtask.id))
                .where(BatchSubtask.batch_id == batch_id)
                .group_by(BatchSubtask.status)
            )
            by_status = {s: int(n) for s, n in counts.all()}
            await db.execute(
                update(BatchRun)
                .where(BatchRun.id == batch_id)
                .values(
                    completed=by_status.get("success", 0),
                    failed=by_status.get("failed", 0),
                    skipped=by_status.get("cancelled", 0) + by_status.get("skipped", 0),
                )
            )
            await db.commit()

    async def retry_failed(self, batch_id: str) -> dict:
        # Reset failed → pending and remember which ids we touched so we can
        # re-enqueue them if the batch is still alive in memory. The previous
        # implementation just called resume_batch(), but for a batch whose
        # producer already finished, those reset rows would never be picked
        # up by any worker.
        async with async_session() as db:
            rows = await db.execute(
                select(BatchSubtask.id)
                .where(BatchSubtask.batch_id == batch_id)
                .where(BatchSubtask.status == "failed")
            )
            failed_ids = [r[0] for r in rows.all()]
            if not failed_ids:
                return {"status": "noop", "retried": 0}
            await db.execute(
                update(BatchSubtask)
                .where(BatchSubtask.id.in_(failed_ids))
                .values(status="pending", retry_count=0, error_message=None)
            )
            await db.commit()

        state = self.states.get(batch_id)
        if state:
            # Live batch — push directly back into the worker queue and clear
            # any pause flag (defensive). Decrement the failed counter so the
            # UI doesn't double-count when these rows finish again.
            for sid in failed_ids:
                await state.queue.put(sid)
            async with state.lock:
                state.failed = max(0, state.failed - len(failed_ids))
            state.paused.clear()
            await self._set_batch_status(batch_id, "running")
            await self._push(state, {"event": "retried", "count": len(failed_ids), **self._counters(state)})
            return {"status": "running", "retried": len(failed_ids)}

        # Batch finalized (completed/failed/cancelled) — flip status so
        # start_batch's gate accepts it, then restart. The producer is
        # idempotent on (seed_id, prompt_id) so it won't duplicate rows.
        async with async_session() as db:
            await db.execute(
                update(BatchRun)
                .where(BatchRun.id == batch_id)
                .values(status="paused", completed_at=None)
            )
            await db.commit()
        result = await self.start_batch(batch_id)
        return {**result, "retried": len(failed_ids)}

    def get_progress_queue(self, batch_id: str) -> asyncio.Queue:
        state = self.states.get(batch_id)
        if state:
            return state.progress_queue
        # No live batch — give callers an empty queue that just blocks
        return asyncio.Queue()

    # ── Producer / Workers ──

    async def _restore_counters(self, state: BatchState) -> None:
        async with async_session() as db:
            counts = await db.execute(
                select(BatchSubtask.status, func.count(BatchSubtask.id))
                .where(BatchSubtask.batch_id == state.batch_id)
                .group_by(BatchSubtask.status)
            )
            for status, n in counts.all():
                if status == "success":
                    state.completed = n
                elif status == "failed":
                    state.failed = n
                elif status == "skipped":
                    state.skipped = n
            cost_row = await db.execute(
                select(func.coalesce(func.sum(BatchSubtask.cost_usd), 0))
                .where(BatchSubtask.batch_id == state.batch_id)
                .where(BatchSubtask.status == "success")
            )
            state.cost_usd = float(cost_row.scalar_one() or 0.0)

    async def _produce_subtasks(
        self,
        batch_id: str,
        seed_ids: list[str],
        prompt_ids: list[str],
        state: BatchState,
    ) -> None:
        """Create rows in chunks; enqueue pending ids as we go.

        Idempotent: if some subtasks already exist (resumed batch), they are
        re-discovered via DB query and reused.
        """
        try:
            existing: set[tuple[str, str]] = set()
            async with async_session() as db:
                rows = await db.execute(
                    select(BatchSubtask.seed_image_id, BatchSubtask.prompt_id, BatchSubtask.id, BatchSubtask.status)
                    .where(BatchSubtask.batch_id == batch_id)
                )
                for seed_id, prompt_id, subtask_id, status in rows.all():
                    existing.add((seed_id, prompt_id))
                    if status == "pending":
                        await state.queue.put(subtask_id)

            chunk: list[BatchSubtask] = []
            for seed_id in seed_ids:
                for prompt_id in prompt_ids:
                    if (seed_id, prompt_id) in existing:
                        continue
                    chunk.append(
                        BatchSubtask(
                            batch_id=batch_id,
                            seed_image_id=seed_id,
                            prompt_id=prompt_id,
                            status="pending",
                            retry_count=0,
                        )
                    )
                    if len(chunk) >= CHUNK_SIZE:
                        await self._flush_chunk(chunk, state)
                        chunk = []
            if chunk:
                await self._flush_chunk(chunk, state)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("Producer for batch %s crashed: %s", batch_id, e)

    async def _flush_chunk(self, chunk: list[BatchSubtask], state: BatchState) -> None:
        async with async_session() as db:
            db.add_all(chunk)
            await db.commit()
            for s in chunk:
                await db.refresh(s)
                await state.queue.put(s.id)

    async def _worker(
        self,
        batch_id: str,
        state: BatchState,
        provider_chain: list[str] | None,
    ) -> None:
        while not state.cancelled.is_set():
            if state.paused.is_set():
                await asyncio.sleep(0.5)
                continue
            try:
                subtask_id = await asyncio.wait_for(state.queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                # Producer might still be feeding. If producer is done AND queue
                # is empty AND no other worker is in-flight, we can finish.
                if state.producer and state.producer.done() and state.queue.empty():
                    await self._maybe_finalize(batch_id, state)
                    return
                continue

            await self._run_subtask(subtask_id, batch_id, state, provider_chain)

        # Cancelled
        await self._maybe_finalize(batch_id, state)

    async def _run_subtask(
        self,
        subtask_id: str,
        batch_id: str,
        state: BatchState,
        provider_chain: list[str] | None,
    ) -> None:
        # Budget gate before spending the call
        if state.budget_usd is not None and state.cost_usd >= state.budget_usd:
            await self._update_subtask(subtask_id, status="skipped", error="budget exhausted")
            async with state.lock:
                state.skipped += 1
            await self._push(state, {"event": "subtask_skipped", "subtask_id": subtask_id, **self._counters(state)})
            return

        async with async_session() as db:
            sub = await db.get(BatchSubtask, subtask_id)
            if not sub:
                return
            # Subset cancellation may have flipped this row to "cancelled"
            # after we pulled its id off the queue. Honour that decision —
            # don't spend money on a row the user already abandoned.
            if sub.status == "cancelled":
                return
            seed = await db.get(Image, sub.seed_image_id)
            prompt = await db.get(Prompt, sub.prompt_id)
            if not seed or not prompt:
                await self._update_subtask(subtask_id, status="failed", error="seed or prompt missing")
                async with state.lock:
                    state.failed += 1
                return
            batch = await db.get(BatchRun, batch_id)
            await db.execute(
                update(BatchSubtask)
                .where(BatchSubtask.id == subtask_id)
                .values(status="running", started_at=datetime.utcnow())
            )
            await db.commit()
            project_id = seed.project_id
            # Read through the effective path so rotated derivatives are used
            # without touching the original bytes. file_path is never rewritten.
            seed_path = effective_file_path(seed)
            seed_relative_dir = seed.relative_dir or ""
            seed_filename = seed.file_name
            prompt_text = prompt.content
            prompt_name = prompt.name
            batch_name = batch.name if batch else "batch"

        # Run pipeline (no PIL fallback in batch — bad pixels poison the dataset)
        gen_started_at = time.perf_counter()
        retry_count = 0
        while True:
            try:
                result = await pipeline.execute(
                    seed_path,
                    prompt_text,
                    provider_chain=provider_chain,
                )
                break
            except PermanentError as e:
                await self._update_subtask(subtask_id, status="failed", error=f"permanent: {e}")
                async with state.lock:
                    state.failed += 1
                    # Circuit breaker: detect auth/quota cascade and pause the
                    # batch so the operator can intervene before more spend.
                    msg = str(e).lower()
                    is_auth = any(t in msg for t in (" 401", " 402", " 403", " 429", "invalid token", "unauthorized", "forbidden", "rate limit"))
                    if is_auth:
                        state.consecutive_auth_failures += 1
                    else:
                        state.consecutive_auth_failures = 0
                    trip = (
                        state.consecutive_auth_failures >= CIRCUIT_BREAKER_AUTH_FAILURES
                        and not state.circuit_tripped
                    )
                    if trip:
                        state.circuit_tripped = True
                await self._update_prompt_stats(prompt.id, success=False)
                await self._push(state, {"event": "subtask_failed", "subtask_id": subtask_id, "error": str(e), **self._counters(state)})
                if trip:
                    logger.warning(
                        "Circuit breaker TRIPPED on batch %s after %d consecutive auth/quota errors — pausing",
                        batch_id, state.consecutive_auth_failures,
                    )
                    state.paused.set()
                    await self._set_batch_status(batch_id, "paused")
                    await self._push(state, {
                        "event": "circuit_tripped",
                        "consecutive": state.consecutive_auth_failures,
                        "reason": "上游连续返回 401/403/429 — 批次已自动暂停以避免空跑费用。请检查 provider 凭证或降低并发后再恢复。",
                    })
                return
            except (TransientError, ProviderError, Exception) as e:
                if retry_count >= state.max_retry:
                    await self._update_subtask(subtask_id, status="failed", error=f"retries exhausted: {e}", retry_count=retry_count)
                    async with state.lock:
                        state.failed += 1
                    await self._update_prompt_stats(prompt.id, success=False)
                    await self._push(state, {"event": "subtask_failed", "subtask_id": subtask_id, "error": str(e), **self._counters(state)})
                    return
                retry_count += 1
                wait_s = 2 ** retry_count  # 2, 4, 8 ...
                logger.info("subtask %s retry %d/%d after %.0fs: %s", subtask_id, retry_count, state.max_retry, wait_s, e)
                await self._update_subtask(subtask_id, status="retrying", retry_count=retry_count)
                await asyncio.sleep(wait_s)

        # Persist the generated image with a sortable, prompt-aware filename.
        # Extension follows the actual bytes (detect magic) — never silently
        # rename PNG bytes to a .jpg file.
        gen_latency_ms = int((time.perf_counter() - gen_started_at) * 1000)
        out_ext = detect_image_extension(result.image_data)
        out_path = _build_output_path(
            batch_name=batch_name,
            seed_relative_dir=seed_relative_dir,
            seed_filename=seed_filename,
            prompt_name=prompt_name,
            subtask_id=subtask_id,
            extension=out_ext,
        )
        try:
            save_image_bytes(result.image_data, out_path)
            with PILImage.open(out_path) as im:
                w, h = im.size
        except Exception as e:
            await self._update_subtask(subtask_id, status="failed", error=f"save failed: {e}")
            async with state.lock:
                state.failed += 1
            return

        gen_meta = {
            "provider": result.provider_used,
            "model": None,                       # provider doesn't currently expose this
            "prompt_id": prompt.id,
            "prompt_name": prompt_name,
            "prompt_content": prompt_text,
            "batch_id": batch_id,
            "batch_name": batch_name,
            "seed_image_id": sub.seed_image_id,
            "seed_file_name": seed_filename,
            "seed_relative_dir": seed_relative_dir,
            "cost_usd": float(result.cost_usd or 0.0),
            "latency_ms": gen_latency_ms,
            "retry_count": retry_count,
            "generated_at": datetime.utcnow().isoformat(),
        }

        async with async_session() as db:
            new_image = Image(
                project_id=project_id,
                file_path=str(out_path),
                file_name=out_path.name,
                width=w,
                height=h,
                file_size_kb=out_path.stat().st_size // 1024,
                quality_status="passed",
                tag_status="pending",
                source_type="generated",
                parent_id=sub.seed_image_id,
                # Inherit the seed's scenic folder so the asset library tree
                # surfaces generated images under the same attraction.
                relative_dir=seed_relative_dir,
                generation_metadata=gen_meta,
            )
            db.add(new_image)
            await db.flush()
            new_image_id = new_image.id
            await db.execute(
                update(BatchSubtask)
                .where(BatchSubtask.id == subtask_id)
                .values(
                    status="success",
                    output_image_id=new_image.id,
                    cost_usd=result.cost_usd,
                    retry_count=retry_count,
                    completed_at=datetime.utcnow(),
                    error_message=None,
                )
            )
            await db.commit()

        # Enqueue OSS sync for the freshly-created generated image. No-op when
        # OSS is disabled. Wrapped so any failure can't poison the batch.
        try:
            from sidecar.engines.oss_sync import enqueue_image_sync
            await enqueue_image_sync(new_image_id)
        except Exception as e:
            logger.debug("oss enqueue (batch) failed for %s: %s", new_image_id, e)

        async with state.lock:
            state.completed += 1
            state.cost_usd += result.cost_usd
            state.consecutive_auth_failures = 0  # success resets the breaker
        await self._update_prompt_stats(prompt.id, success=True, cost_usd=result.cost_usd)
        await self._sync_batch_counters(batch_id, state)
        await self._push(state, {
            "event": "subtask_success",
            "subtask_id": subtask_id,
            "provider": result.provider_used,
            "cost_usd": result.cost_usd,
            **self._counters(state),
        })

    # ── Persistence helpers ──

    async def _update_subtask(
        self,
        subtask_id: str,
        *,
        status: str,
        error: str | None = None,
        retry_count: int | None = None,
    ) -> None:
        values: dict[str, Any] = {"status": status}
        if error is not None:
            values["error_message"] = error
        if retry_count is not None:
            values["retry_count"] = retry_count
        if status in ("failed", "skipped"):
            values["completed_at"] = datetime.utcnow()
        async with async_session() as db:
            await db.execute(update(BatchSubtask).where(BatchSubtask.id == subtask_id).values(**values))
            await db.commit()

    async def _sync_batch_counters(self, batch_id: str, state: BatchState) -> None:
        async with async_session() as db:
            await db.execute(
                update(BatchRun)
                .where(BatchRun.id == batch_id)
                .values(
                    completed=state.completed,
                    failed=state.failed,
                    skipped=state.skipped,
                    cost_usd=state.cost_usd,
                )
            )
            await db.commit()

    async def _set_batch_status(self, batch_id: str, status: str, *, set_completed_at: bool = False) -> None:
        values: dict[str, Any] = {"status": status}
        if set_completed_at:
            values["completed_at"] = datetime.utcnow()
        async with async_session() as db:
            await db.execute(update(BatchRun).where(BatchRun.id == batch_id).values(**values))
            await db.commit()

    async def _update_prompt_stats(
        self,
        prompt_id: str,
        *,
        success: bool,
        cost_usd: float | None = None,
    ) -> None:
        async with async_session() as db:
            p = await db.get(Prompt, prompt_id)
            if not p:
                return
            stats = dict(p.stats or {})
            sc = int(stats.get("success_count", 0))
            fc = int(stats.get("fail_count", 0))
            cost_total = float(stats.get("cost_total_usd", 0.0))
            if success:
                sc += 1
                if cost_usd is not None:
                    cost_total += float(cost_usd)
            else:
                fc += 1
            stats["success_count"] = sc
            stats["fail_count"] = fc
            stats["cost_total_usd"] = round(cost_total, 6)
            stats["avg_cost_usd"] = round(cost_total / max(sc, 1), 6)
            stats["last_used_at"] = datetime.utcnow().isoformat()
            await db.execute(update(Prompt).where(Prompt.id == prompt_id).values(stats=stats))
            await db.commit()

    async def _maybe_finalize(self, batch_id: str, state: BatchState) -> None:
        if state.cancelled.is_set():
            await self._set_batch_status(batch_id, "cancelled", set_completed_at=True)
            self.states.pop(batch_id, None)
            return
        # Producer done + queue empty + all workers idle → batch is done
        if state.producer and state.producer.done() and state.queue.empty():
            done_count = state.completed + state.failed + state.skipped
            if done_count >= state.total:
                final_status = "completed" if state.failed == 0 else "completed"
                await self._sync_batch_counters(batch_id, state)
                await self._set_batch_status(batch_id, final_status, set_completed_at=True)
                await self._enqueue_auto_tag(batch_id)
                await self._push(state, {"event": "completed", **self._counters(state)})
                self.states.pop(batch_id, None)

    async def _enqueue_auto_tag(self, batch_id: str) -> None:
        """Queue a tag task scoped to images generated by this batch.

        We collect output_image_id from every successful subtask and pass them
        to the tagger via task.parameters.image_ids. Tagger respects this list
        and skips its default `tag_status=pending` project-wide query.
        """
        async with async_session() as db:
            rows = await db.execute(
                select(BatchSubtask.output_image_id, BatchRun.project_id, BatchRun.name)
                .join(BatchRun, BatchSubtask.batch_id == BatchRun.id)
                .where(BatchSubtask.batch_id == batch_id)
                .where(BatchSubtask.status == "success")
                .where(BatchSubtask.output_image_id.is_not(None))
            )
            data = rows.all()
            if not data:
                logger.info("auto-tag: batch %s has no successful outputs, skipping", batch_id)
                return
            image_ids = [r[0] for r in data]
            project_id = data[0][1]
            batch_name = data[0][2]

            task = Task(
                project_id=project_id,
                type="tag",
                status="queued",
                parameters=json.dumps({
                    "image_ids": image_ids,
                    "auto_triggered_by_batch": batch_id,
                    "label": f"自动打标 · {batch_name}",
                }),
            )
            db.add(task)
            await db.commit()
            await db.refresh(task)
            logger.info("auto-tag enqueued (task=%s) for %d generated images", task.id, len(image_ids))

    @staticmethod
    def _counters(state: BatchState) -> dict[str, Any]:
        return {
            "total": state.total,
            "completed": state.completed,
            "failed": state.failed,
            "skipped": state.skipped,
            "cost_usd": round(state.cost_usd, 4),
        }

    async def _push(self, state: BatchState, payload: dict) -> None:
        try:
            await state.progress_queue.put(payload)
        except Exception:
            pass


batch_scheduler = BatchScheduler()
