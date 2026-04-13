import asyncio
import json
import logging
from datetime import datetime
from typing import Any, Callable, Coroutine, Dict

from sqlalchemy import select, update
from sidecar.db.session import async_session
from sidecar.db.models import Task

logger = logging.getLogger(__name__)

# Task types by resource consumption
API_TASKS = {"tag"}
CPU_TASKS = {"quality_check", "dedup", "thumbnail", "scan"}

TaskHandler = Callable[["Task", "ProgressCallback"], Coroutine[Any, Any, None]]
ProgressCallback = Callable[..., Coroutine[Any, Any, None]]


class TaskScheduler:
    def __init__(self):
        self.api_semaphore = asyncio.Semaphore(5)
        self.cpu_semaphore = asyncio.Semaphore(2)
        self.handlers: Dict[str, TaskHandler] = {}
        self.running_tasks: Dict[str, asyncio.Task] = {}
        self.progress_queues: Dict[str, asyncio.Queue] = {}
        self._stopped = False
        self._loop_task: asyncio.Task | None = None

    def register(self, task_type: str, handler: TaskHandler):
        self.handlers[task_type] = handler

    async def start(self):
        self._stopped = False
        # Mark any stale 'running' tasks as 'paused' on startup
        async with async_session() as db:
            await db.execute(
                update(Task).where(Task.status == "running").values(status="paused")
            )
            await db.commit()
        self._loop_task = asyncio.create_task(self._main_loop())
        logger.info("TaskScheduler started")

    async def stop(self):
        self._stopped = True
        # Cancel running asyncio tasks
        for task_id, atask in self.running_tasks.items():
            atask.cancel()
        self.running_tasks.clear()
        if self._loop_task:
            self._loop_task.cancel()
        logger.info("TaskScheduler stopped")

    async def _main_loop(self):
        while not self._stopped:
            try:
                task = await self._fetch_next_task()
                if task:
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

    async def _fetch_next_task(self) -> Task | None:
        async with async_session() as db:
            result = await db.execute(
                select(Task)
                .where(Task.status == "queued")
                .order_by(Task.created_at)
                .limit(1)
            )
            task = result.scalar_one_or_none()
            if task:
                # Detach from session so we can use it across awaits
                db.expunge(task)
            return task

    async def _execute(self, task: Task):
        handler = self.handlers.get(task.type)
        if not handler:
            await self._mark_failed(task.id, f"Unknown task type: {task.type}")
            return

        semaphore = self.api_semaphore if task.type in API_TASKS else self.cpu_semaphore

        async with semaphore:
            try:
                await self._mark_running(task.id)

                async def progress_cb(**kwargs):
                    await self._update_progress(task.id, **kwargs)

                await handler(task, progress_cb)
                await self._mark_completed(task.id)
            except asyncio.CancelledError:
                await self._mark_status(task.id, "cancelled")
            except Exception as e:
                logger.error(f"Task {task.id} failed: {e}")
                await self._mark_failed(task.id, str(e))
            finally:
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
