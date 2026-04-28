import asyncio
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Callable, Coroutine, Dict

from sqlalchemy import select, update
from sidecar.db.session import async_session
from sidecar.db.models import Task

logger = logging.getLogger(__name__)

# Task types by resource consumption
API_TASKS = {"tag", "parse_prompt"}
# CPU-heavy but independent of the 2-core CPU pool — embeds batch on GPU/MPS.
# Reuse CPU pool for now to keep contention simple.
CPU_TASKS = {"quality_check", "dedup", "thumbnail", "scan"}

TaskHandler = Callable[["Task", "ProgressCallback"], Coroutine[Any, Any, None]]
ProgressCallback = Callable[..., Coroutine[Any, Any, None]]


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        n = int(raw)
        return n if n > 0 else default
    except ValueError:
        return default


class TaskScheduler:
    def __init__(self):
        # Concurrency tunables. Bump LINTU_API_CONCURRENCY to run more
        # provider-heavy tasks (打标 / 解析 prompt) in parallel; bump
        # LINTU_CPU_CONCURRENCY for local CPU work (质量检查 / 去重 /
        # 缩略图 / 扫描). Defaults are conservative.
        self.api_concurrency = _env_int("LINTU_API_CONCURRENCY", 8)
        self.cpu_concurrency = _env_int("LINTU_CPU_CONCURRENCY", 3)
        self.api_semaphore = asyncio.Semaphore(self.api_concurrency)
        self.cpu_semaphore = asyncio.Semaphore(self.cpu_concurrency)
        self.handlers: Dict[str, TaskHandler] = {}
        self.running_tasks: Dict[str, asyncio.Task] = {}
        self.progress_queues: Dict[str, asyncio.Queue] = {}
        # Set of task IDs we've handed off to an _execute coroutine but
        # whose `_mark_running` may not have committed yet. The fetch query
        # excludes these so the same row can't be picked twice — eliminates
        # the orphan-coroutine pile-up that was holding semaphore slots.
        self.in_flight_ids: set[str] = set()
        self._stopped = False
        self._loop_task: asyncio.Task | None = None
        self._watchdog_task: asyncio.Task | None = None
        # How long a task can stay "running" with no progress event before
        # the watchdog declares it ghost and recovers it. Generous so a
        # single slow API call doesn't trigger spurious recovery.
        self.stuck_after_seconds = _env_int("LINTU_STUCK_AFTER_SECONDS", 600)

    def register(self, task_type: str, handler: TaskHandler):
        self.handlers[task_type] = handler

    async def start(self):
        self._stopped = False
        async with async_session() as db:
            # Stale 'running' → 'paused' (user can resume if they want).
            # Sidecar just restarted, so anything still marked running in
            # DB is by definition orphaned.
            await db.execute(
                update(Task).where(Task.status == "running").values(status="paused")
            )
            # Queued one-shot internal tasks (parse_prompt) from a previous
            # process are stale — their progress queues are gone, re-running
            # them would duplicate side effects. Mark them cancelled.
            await db.execute(
                update(Task)
                .where(Task.status == "queued")
                .where(Task.type == "parse_prompt")
                .values(status="cancelled", error_message="stale: sidecar restarted")
            )
            await db.commit()
        self._loop_task = asyncio.create_task(self._main_loop())
        self._watchdog_task = asyncio.create_task(self._watchdog_loop())
        logger.info(
            "TaskScheduler started (api=%d, cpu=%d, stuck_after=%ds)",
            self.api_concurrency, self.cpu_concurrency, self.stuck_after_seconds,
        )

    async def stop(self):
        self._stopped = True
        for atask in self.running_tasks.values():
            atask.cancel()
        self.running_tasks.clear()
        self.in_flight_ids.clear()
        for atask in (self._loop_task, self._watchdog_task):
            if atask:
                atask.cancel()
        logger.info("TaskScheduler stopped")

    async def _main_loop(self):
        while not self._stopped:
            try:
                task = await self._fetch_next_task()
                if task:
                    # Reserve the slot synchronously (before any await) so a
                    # second fetch in this same tick can't pick the same row.
                    self.in_flight_ids.add(task.id)
                    self.running_tasks[task.id] = asyncio.create_task(
                        self._execute(task)
                    )
                else:
                    await asyncio.sleep(1)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Scheduler loop error: {e}")
                await asyncio.sleep(2)

    async def _watchdog_loop(self):
        """Recover ghost rows: any 'running' task whose started_at is older
        than `stuck_after_seconds` AND is not currently being executed by
        this process. Without this, a hung HTTP call or a hard kill would
        leave the task wedged and block new tasks of the same type forever.
        """
        while not self._stopped:
            try:
                await asyncio.sleep(60)
                cutoff = datetime.utcnow() - timedelta(seconds=self.stuck_after_seconds)
                async with async_session() as db:
                    rows = (await db.execute(
                        select(Task).where(Task.status == "running")
                        .where(Task.started_at != None)  # noqa: E711
                        .where(Task.started_at < cutoff)
                    )).scalars().all()
                    recovered = 0
                    for t in rows:
                        if t.id in self.in_flight_ids:
                            continue  # we're actually still working on it
                        await db.execute(
                            update(Task).where(Task.id == t.id).values(
                                status="failed",
                                completed_at=datetime.utcnow(),
                                error_message=(t.error_message or "")
                                + " | watchdog: stuck >"
                                + f"{self.stuck_after_seconds}s without heartbeat",
                            )
                        )
                        recovered += 1
                    if recovered:
                        await db.commit()
                        logger.warning(
                            "watchdog: recovered %d stuck running task(s)", recovered
                        )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("watchdog error: %s", e)

    async def _fetch_next_task(self) -> Task | None:
        async with async_session() as db:
            query = (
                select(Task)
                .where(Task.status == "queued")
                .order_by(Task.created_at)
                .limit(1)
            )
            if self.in_flight_ids:
                query = query.where(~Task.id.in_(list(self.in_flight_ids)))
            result = await db.execute(query)
            task = result.scalar_one_or_none()
            if task:
                # Detach from session so we can use it across awaits
                db.expunge(task)
            return task

    async def _execute(self, task: Task):
        handler = self.handlers.get(task.type)
        if not handler:
            await self._mark_failed(task.id, f"Unknown task type: {task.type}")
            self.in_flight_ids.discard(task.id)
            self.running_tasks.pop(task.id, None)
            return

        semaphore = self.api_semaphore if task.type in API_TASKS else self.cpu_semaphore

        try:
            async with semaphore:
                try:
                    await self._mark_running(task.id)

                    async def progress_cb(**kwargs):
                        await self._update_progress(task.id, **kwargs)

                    await handler(task, progress_cb)
                    await self._mark_completed(task.id)
                except asyncio.CancelledError:
                    await self._mark_status(task.id, "cancelled")
                    raise
                except Exception as e:
                    logger.error(f"Task {task.id} failed: {e}")
                    await self._mark_failed(task.id, str(e))
        finally:
            # Always release our reservation so a future restart of this
            # task (resume / retry) can be picked up.
            self.in_flight_ids.discard(task.id)
            self.running_tasks.pop(task.id, None)

    async def _mark_running(self, task_id: str):
        async with async_session() as db:
            await db.execute(
                update(Task)
                .where(Task.id == task_id)
                .values(status="running", started_at=datetime.utcnow())
            )
            await db.commit()
        await self._push_event(task_id, {"status": "running"})

    async def _mark_completed(self, task_id: str):
        async with async_session() as db:
            await db.execute(
                update(Task)
                .where(Task.id == task_id)
                .values(status="completed", completed_at=datetime.utcnow())
            )
            await db.commit()
        await self._push_event(task_id, {"status": "completed"})

    async def _mark_failed(self, task_id: str, error: str):
        async with async_session() as db:
            await db.execute(
                update(Task)
                .where(Task.id == task_id)
                .values(status="failed", error_message=error, completed_at=datetime.utcnow())
            )
            await db.commit()
        await self._push_event(task_id, {"status": "failed", "error": error})

    async def _mark_status(self, task_id: str, status: str):
        async with async_session() as db:
            await db.execute(
                update(Task).where(Task.id == task_id).values(status=status)
            )
            await db.commit()
        await self._push_event(task_id, {"status": status})

    async def _update_progress(self, task_id: str, **kwargs):
        async with async_session() as db:
            values: dict = {}
            if "processed" in kwargs:
                values["processed"] = kwargs["processed"]
            if "total" in kwargs:
                values["total"] = kwargs["total"]
            if "failed" in kwargs:
                values["failed"] = kwargs["failed"]
            if "cost_usd" in kwargs:
                values["cost_usd"] = kwargs["cost_usd"]
            if values:
                await db.execute(
                    update(Task).where(Task.id == task_id).values(**values)
                )
                await db.commit()
        await self._push_event(task_id, kwargs)

    def get_progress_queue(self, task_id: str) -> asyncio.Queue:
        if task_id not in self.progress_queues:
            self.progress_queues[task_id] = asyncio.Queue()
        return self.progress_queues[task_id]

    async def _push_event(self, task_id: str, data: dict):
        q = self.progress_queues.get(task_id)
        if q:
            await q.put(data)

    async def cancel_task(self, task_id: str):
        atask = self.running_tasks.get(task_id)
        if atask:
            atask.cancel()
        else:
            await self._mark_status(task_id, "cancelled")

    async def pause_task(self, task_id: str):
        atask = self.running_tasks.get(task_id)
        if atask:
            atask.cancel()
            await self._mark_status(task_id, "paused")
        else:
            await self._mark_status(task_id, "paused")

    async def resume_task(self, task_id: str):
        # Re-queue: set status back to queued, the loop will pick it up
        await self._mark_status(task_id, "queued")
