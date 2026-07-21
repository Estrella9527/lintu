"""BatchRun CRUD (Sprint 1 — data plane only).

Scheduling logic (lazy subtask creation, provider chain, retry, budget) is
implemented by BatchScheduler in Sprint 2. This router exposes the read/write
surface so the frontend and tests can exercise the schema today.
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import BatchRun, BatchSubtask
from sidecar.db.session import get_db
from sidecar.scheduler.batch_engine import batch_scheduler
from sidecar.time_utils import utc_iso

router = APIRouter()


class BatchCreateBody(BaseModel):
    project_id: str
    name: str
    task_type: str
    seed_image_ids: list[str]
    prompt_ids: list[str]
    strategy_id: Optional[str] = None
    concurrency: int = 10
    max_retry: int = 3
    provider_chain: Optional[list[str]] = None
    budget_usd: Optional[float] = None


def _batch_to_dict(b: BatchRun) -> dict:
    return {
        "id": b.id,
        "project_id": b.project_id,
        "name": b.name,
        "task_type": b.task_type,
        "strategy_id": b.strategy_id,
        "seed_image_ids": b.seed_image_ids or [],
        "prompt_ids": b.prompt_ids or [],
        "total": b.total or 0,
        "completed": b.completed or 0,
        "failed": b.failed or 0,
        "skipped": b.skipped or 0,
        "status": b.status,
        "concurrency": b.concurrency,
        "max_retry": b.max_retry,
        "provider_chain": b.provider_chain,
        "budget_usd": float(b.budget_usd) if b.budget_usd is not None else None,
        "cost_usd": float(b.cost_usd) if b.cost_usd is not None else 0.0,
        "started_at": utc_iso(b.started_at),
        "completed_at": utc_iso(b.completed_at),
        "created_at": utc_iso(b.created_at),
        "updated_at": utc_iso(b.updated_at),
    }


def _subtask_to_dict(s: BatchSubtask) -> dict:
    return {
        "id": s.id,
        "batch_id": s.batch_id,
        "seed_image_id": s.seed_image_id,
        "prompt_id": s.prompt_id,
        "status": s.status,
        "retry_count": s.retry_count or 0,
        "output_image_id": s.output_image_id,
        "cost_usd": float(s.cost_usd) if s.cost_usd is not None else None,
        "error_message": s.error_message,
        "started_at": utc_iso(s.started_at),
        "completed_at": utc_iso(s.completed_at),
    }


@router.get("")
async def list_batches(
    project_id: Optional[str] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(BatchRun).order_by(BatchRun.created_at.desc())
    if project_id:
        q = q.where(BatchRun.project_id == project_id)
    if status:
        q = q.where(BatchRun.status == status)
    rows = await db.execute(q)
    return [_batch_to_dict(b) for b in rows.scalars().all()]


@router.post("")
async def create_batch(body: BatchCreateBody, db: AsyncSession = Depends(get_db)):
    if not body.seed_image_ids or not body.prompt_ids:
        raise HTTPException(400, "seed_image_ids and prompt_ids must be non-empty")
    total = len(body.seed_image_ids) * len(body.prompt_ids)
    batch = BatchRun(
        project_id=body.project_id,
        name=body.name,
        task_type=body.task_type,
        strategy_id=body.strategy_id,
        seed_image_ids=body.seed_image_ids,
        prompt_ids=body.prompt_ids,
        total=total,
        status="pending",
        concurrency=body.concurrency,
        max_retry=body.max_retry,
        provider_chain=body.provider_chain,
        budget_usd=body.budget_usd,
    )
    db.add(batch)
    await db.commit()
    await db.refresh(batch)
    return _batch_to_dict(batch)


@router.get("/{batch_id}")
async def get_batch(batch_id: str, db: AsyncSession = Depends(get_db)):
    batch = await db.get(BatchRun, batch_id)
    if not batch:
        raise HTTPException(404, "BatchRun not found")
    return _batch_to_dict(batch)


@router.get("/{batch_id}/subtasks")
async def list_subtasks(
    batch_id: str,
    status: Optional[str] = None,
    prompt_id: Optional[str] = None,
    seed_image_id: Optional[str] = None,
    limit: int = Query(200, le=2000),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    q = select(BatchSubtask).where(BatchSubtask.batch_id == batch_id)
    if status:
        q = q.where(BatchSubtask.status == status)
    if prompt_id:
        q = q.where(BatchSubtask.prompt_id == prompt_id)
    if seed_image_id:
        q = q.where(BatchSubtask.seed_image_id == seed_image_id)
    q = q.offset(offset).limit(limit)
    rows = await db.execute(q)
    return [_subtask_to_dict(s) for s in rows.scalars().all()]


@router.get("/{batch_id}/group-by-prompt")
async def group_by_prompt(batch_id: str, db: AsyncSession = Depends(get_db)):
    """Per-Prompt success/fail counts within a batch (for the detail panel)."""
    rows = await db.execute(
        select(
            BatchSubtask.prompt_id,
            BatchSubtask.status,
            func.count(BatchSubtask.id),
            func.sum(BatchSubtask.cost_usd),
        )
        .where(BatchSubtask.batch_id == batch_id)
        .group_by(BatchSubtask.prompt_id, BatchSubtask.status)
    )
    out: dict[str, dict] = {}
    for prompt_id, status, count, cost_sum in rows.all():
        bucket = out.setdefault(
            prompt_id,
            {"prompt_id": prompt_id, "total": 0, "by_status": {}, "cost_usd": 0.0},
        )
        bucket["by_status"][status] = count
        bucket["total"] += count
        if cost_sum is not None:
            bucket["cost_usd"] += float(cost_sum)
    return list(out.values())


@router.delete("/{batch_id}")
async def delete_batch(batch_id: str, db: AsyncSession = Depends(get_db)):
    batch = await db.get(BatchRun, batch_id)
    if not batch:
        raise HTTPException(404, "BatchRun not found")
    if batch.status == "running":
        raise HTTPException(400, "Cannot delete a running batch — cancel it first")
    await db.delete(batch)
    await db.commit()
    return {"ok": True}


# ── Control plane (S2.3) ──


@router.post("/{batch_id}/start")
async def start_batch(batch_id: str):
    try:
        return await batch_scheduler.start_batch(batch_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{batch_id}/pause")
async def pause_batch(batch_id: str):
    return await batch_scheduler.pause_batch(batch_id)


@router.post("/{batch_id}/resume")
async def resume_batch(batch_id: str):
    try:
        return await batch_scheduler.resume_batch(batch_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{batch_id}/cancel")
async def cancel_batch(batch_id: str):
    return await batch_scheduler.cancel_batch(batch_id)


@router.post("/{batch_id}/retry-failed")
async def retry_failed(batch_id: str):
    return await batch_scheduler.retry_failed(batch_id)


@router.post("/{batch_id}/cancel-by-prompt/{prompt_id}")
async def cancel_by_prompt(batch_id: str, prompt_id: str):
    try:
        return await batch_scheduler.cancel_subtasks(batch_id, prompt_id=prompt_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{batch_id}/cancel-by-seed/{seed_id}")
async def cancel_by_seed(batch_id: str, seed_id: str):
    try:
        return await batch_scheduler.cancel_subtasks(batch_id, seed_image_id=seed_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/{batch_id}/stream")
async def stream_batch(batch_id: str):
    queue = batch_scheduler.get_progress_queue(batch_id)

    async def gen():
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=30)
                yield f"data: {json.dumps(event, default=str)}\n\n"
                if event.get("event") in ("completed", "cancelled"):
                    break
            except asyncio.TimeoutError:
                yield ":keepalive\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
