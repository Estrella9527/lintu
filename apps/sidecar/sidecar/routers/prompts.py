"""Prompt template CRUD + version management + stats."""

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, Prompt
from sidecar.db.session import get_db

router = APIRouter()


class PromptBody(BaseModel):
    name: str
    category: str
    content: str
    is_default: bool = False
    task_type: Optional[str] = None
    negative_prompt: Optional[str] = None
    variables: Optional[list[dict[str, Any]]] = None
    source: Optional[str] = "manual"
    source_doc_id: Optional[str] = None
    tags: Optional[list[str]] = None
    is_active: Optional[bool] = True


def _to_dict(p: Prompt) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "category": p.category,
        "content": p.content,
        "is_default": p.is_default,
        "task_type": p.task_type,
        "negative_prompt": p.negative_prompt,
        "variables": p.variables,
        "source": p.source,
        "source_doc_id": p.source_doc_id,
        "tags": p.tags,
        "stats": p.stats,
        "is_active": p.is_active,
        "version": p.version,
        "parent_id": p.parent_id,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


@router.get("")
async def list_prompts(
    category: Optional[str] = None,
    task_type: Optional[str] = None,
    is_active: Optional[bool] = None,
    tag: Optional[str] = None,
    q: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    query = select(Prompt)
    if category:
        query = query.where(Prompt.category == category)
    if task_type:
        query = query.where(Prompt.task_type == task_type)
    if is_active is not None:
        query = query.where(Prompt.is_active == is_active)
    if q:
        like = f"%{q}%"
        query = query.where((Prompt.name.like(like)) | (Prompt.content.like(like)))
    query = query.order_by(Prompt.category, Prompt.name)
    result = await db.execute(query)
    items = [_to_dict(p) for p in result.scalars().all()]
    if tag:
        items = [it for it in items if it["tags"] and tag in it["tags"]]
    return items


@router.get("/with-output-counts")
async def list_prompts_with_output_counts(
    project_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """List every prompt + how many generated images use it.

    Counts come from `Image.generation_metadata.prompt_id` (set by
    BatchScheduler on every successful subtask). A prompt that has never
    been used returns count=0 — caller may filter.

    Implementation note: SQLite `json_extract` lets us aggregate without
    pulling all generation_metadata rows into Python. PostgreSQL would
    use `->>'prompt_id'` instead.
    """
    img_q = select(
        func.json_extract(Image.generation_metadata, "$.prompt_id").label("pid"),
        func.count(Image.id).label("n"),
    ).where(Image.generation_metadata.is_not(None))
    if project_id:
        img_q = img_q.where(Image.project_id == project_id)
    img_q = img_q.group_by("pid")

    rows = await db.execute(img_q)
    counts: dict[str, int] = {}
    for pid, n in rows.all():
        if pid:
            counts[str(pid)] = int(n)

    prompts = await db.execute(select(Prompt).order_by(Prompt.name))
    items = []
    for p in prompts.scalars().all():
        items.append({
            "id": p.id,
            "name": p.name,
            "category": p.category,
            "task_type": p.task_type,
            "is_active": p.is_active,
            "output_count": counts.get(p.id, 0),
        })
    # High-usage prompts first; ties by name. Lets users find the busy ones
    # without scrolling.
    items.sort(key=lambda it: (-it["output_count"], it["name"]))
    return items


@router.get("/stats")
async def prompts_stats(db: AsyncSession = Depends(get_db)):
    """Aggregate stats — total / active / per task_type / per category."""
    total = (await db.execute(select(func.count(Prompt.id)))).scalar_one()
    active = (
        await db.execute(select(func.count(Prompt.id)).where(Prompt.is_active.is_(True)))
    ).scalar_one()
    by_task = await db.execute(
        select(Prompt.task_type, func.count(Prompt.id)).group_by(Prompt.task_type)
    )
    by_cat = await db.execute(
        select(Prompt.category, func.count(Prompt.id)).group_by(Prompt.category)
    )
    return {
        "total": total,
        "active": active,
        "by_task_type": {k or "_unknown": v for k, v in by_task.all()},
        "by_category": {k or "_unknown": v for k, v in by_cat.all()},
    }


@router.post("")
async def create_prompt(body: PromptBody, db: AsyncSession = Depends(get_db)):
    prompt = Prompt(
        name=body.name,
        category=body.category,
        content=body.content,
        is_default=body.is_default,
        task_type=body.task_type,
        negative_prompt=body.negative_prompt,
        variables=body.variables,
        source=body.source or "manual",
        source_doc_id=body.source_doc_id,
        tags=body.tags,
        is_active=body.is_active if body.is_active is not None else True,
    )
    db.add(prompt)
    await db.commit()
    await db.refresh(prompt)
    return _to_dict(prompt)


@router.put("/{prompt_id}")
async def update_prompt(prompt_id: str, body: PromptBody, db: AsyncSession = Depends(get_db)):
    prompt = await db.get(Prompt, prompt_id)
    if not prompt:
        raise HTTPException(404, "Prompt not found")
    prompt.name = body.name
    prompt.category = body.category
    prompt.content = body.content
    prompt.is_default = body.is_default
    prompt.task_type = body.task_type
    prompt.negative_prompt = body.negative_prompt
    prompt.variables = body.variables
    if body.source is not None:
        prompt.source = body.source
    prompt.source_doc_id = body.source_doc_id
    prompt.tags = body.tags
    if body.is_active is not None:
        prompt.is_active = body.is_active
    await db.commit()
    return _to_dict(prompt)


@router.post("/{prompt_id}/duplicate-as-version")
async def duplicate_as_version(
    prompt_id: str,
    body: PromptBody,
    db: AsyncSession = Depends(get_db),
):
    """Save edits as a new version row, leaving the previous one intact.

    The new row sets parent_id to the original (or the original's root) and
    bumps version. The caller is expected to mark the previous row inactive
    if the new version supersedes it (kept explicit so callers can decide).
    """
    parent = await db.get(Prompt, prompt_id)
    if not parent:
        raise HTTPException(404, "Prompt not found")
    new_version = (parent.version or 1) + 1
    child = Prompt(
        name=body.name,
        category=body.category,
        content=body.content,
        is_default=body.is_default,
        task_type=body.task_type,
        negative_prompt=body.negative_prompt,
        variables=body.variables,
        source=body.source or parent.source or "manual",
        source_doc_id=body.source_doc_id or parent.source_doc_id,
        tags=body.tags,
        is_active=body.is_active if body.is_active is not None else True,
        version=new_version,
        parent_id=parent.id,
    )
    db.add(child)
    await db.commit()
    await db.refresh(child)
    return _to_dict(child)


@router.get("/{prompt_id}/versions")
async def list_versions(prompt_id: str, db: AsyncSession = Depends(get_db)):
    """Return the version chain for a prompt (parent + descendants)."""
    root = await db.get(Prompt, prompt_id)
    if not root:
        raise HTTPException(404, "Prompt not found")
    # Walk up to root
    while root.parent_id:
        nxt = await db.get(Prompt, root.parent_id)
        if not nxt:
            break
        root = nxt
    # Collect descendants
    chain = [root]
    frontier = [root.id]
    while frontier:
        rows = await db.execute(select(Prompt).where(Prompt.parent_id.in_(frontier)))
        children = rows.scalars().all()
        if not children:
            break
        chain.extend(children)
        frontier = [c.id for c in children]
    chain.sort(key=lambda p: (p.version or 1, p.created_at or datetime.min))
    return [_to_dict(p) for p in chain]


@router.delete("/{prompt_id}")
async def delete_prompt(prompt_id: str, db: AsyncSession = Depends(get_db)):
    prompt = await db.get(Prompt, prompt_id)
    if not prompt:
        raise HTTPException(404, "Prompt not found")
    await db.delete(prompt)
    await db.commit()
    return {"ok": True}
