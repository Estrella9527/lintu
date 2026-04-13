"""Prompt template CRUD."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Prompt
from sidecar.db.session import get_db

router = APIRouter()


class PromptBody(BaseModel):
    name: str
    category: str
    content: str
    is_default: bool = False


@router.get("")
async def list_prompts(category: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    query = select(Prompt).order_by(Prompt.category, Prompt.name)
    if category:
        query = query.where(Prompt.category == category)
    result = await db.execute(query)
    return [_to_dict(p) for p in result.scalars().all()]


@router.post("")
async def create_prompt(body: PromptBody, db: AsyncSession = Depends(get_db)):
    prompt = Prompt(name=body.name, category=body.category, content=body.content, is_default=body.is_default)
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
    await db.commit()
    return _to_dict(prompt)


@router.delete("/{prompt_id}")
async def delete_prompt(prompt_id: str, db: AsyncSession = Depends(get_db)):
    prompt = await db.get(Prompt, prompt_id)
    if not prompt:
        raise HTTPException(404, "Prompt not found")
    await db.delete(prompt)
    await db.commit()
    return {"ok": True}


def _to_dict(p: Prompt) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "category": p.category,
        "content": p.content,
        "is_default": p.is_default,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }
