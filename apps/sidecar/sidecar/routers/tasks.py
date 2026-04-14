import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Task
from sidecar.db.session import get_db

router = APIRouter()

# Scheduler reference — set by main.py after app creation
_scheduler = None


def set_scheduler(scheduler):
    global _scheduler
    _scheduler = scheduler


class CreateTaskBody(BaseModel):
    project_id: str
    type: str
    parameters: dict = {}


class BatchTaskBody(BaseModel):
    tasks: list[CreateTaskBody]


@router.post("/batch")
async def create_batch(body: BatchTaskBody, db: AsyncSession = Depends(get_db)):
    """Create multiple tasks at once."""
    task_ids = []
    for t in body.tasks:
        task = Task(
            project_id=t.project_id,
            type=t.type,
            parameters=json.dumps(t.parameters),
            status="queued",
        )
        db.add(task)
        await db.flush()
        task_ids.append(task.id)
    await db.commit()
    return {"task_ids": task_ids, "count": len(task_ids)}


@router.post("")
async def create_task(body: CreateTaskBody, db: AsyncSession = Depends(get_db)):
    task = Task(
        project_id=body.project_id,
        type=body.type,
        parameters=json.dumps(body.parameters),
        status="queued",
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return {"task_id": task.id}


@router.get("")
async def list_tasks(
    project_id: Optional[str] = None,
    type: Optional[str] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    query = select(Task).order_by(Task.created_at.desc())
    if project_id:
        query = query.where(Task.project_id == project_id)
    if type:
        query = query.where(Task.type == type)
    if status:
        query = query.where(Task.status == status)
    result = await db.execute(query.limit(100))
    tasks = result.scalars().all()
    return [_task_to_dict(t) for t in tasks]


@router.get("/{task_id}")
async def get_task(task_id: str, db: AsyncSession = Depends(get_db)):
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return _task_to_dict(task)


@router.post("/{task_id}/pause")
async def pause_task(task_id: str):
    if _scheduler:
        await _scheduler.pause_task(task_id)
    return {"ok": True}


@router.post("/{task_id}/resume")
async def resume_task(task_id: str):
    if _scheduler:
        await _scheduler.resume_task(task_id)
    return {"ok": True}


@router.post("/{task_id}/cancel")
async def cancel_task(task_id: str):
    if _scheduler:
        await _scheduler.cancel_task(task_id)
    return {"ok": True}


def _task_to_dict(t: Task) -> dict:
    return {
        "id": t.id,
        "project_id": t.project_id,
        "type": t.type,
        "status": t.status,
        "parameters": t.parameters,
        "total": t.total,
        "processed": t.processed,
        "failed": t.failed,
        "cost_usd": t.cost_usd,
        "started_at": t.started_at.isoformat() if t.started_at else None,
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "error_message": t.error_message,
    }
