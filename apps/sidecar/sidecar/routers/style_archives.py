"""StyleArchive CRUD — v0.3 一致性风格档案。

每个项目可以有多个 StyleArchive(如「晨曦丁达尔」「秋日金黄」等风格),
画布和批量策略都可以挑一个应用到本次生成,让跨图风格保持一致。

字段语义见 db/models.py 的 StyleArchive class。这里只做薄薄的 REST 包装,
不做业务校验之外的额外逻辑(strength / params 由前端 UI 自己约束范围)。
"""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import StyleArchive
from sidecar.db.session import get_db

router = APIRouter()


class StyleArchiveCreate(BaseModel):
    project_id: str
    name: str = Field(..., min_length=1, max_length=128)
    description: str = ""
    ref_image_ids: List[str] = Field(default_factory=list, max_length=20)
    strength_default: float = Field(0.7, ge=0.0, le=1.0)
    params: dict = Field(default_factory=dict)


class StyleArchivePatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=128)
    description: Optional[str] = None
    ref_image_ids: Optional[List[str]] = Field(None, max_length=20)
    strength_default: Optional[float] = Field(None, ge=0.0, le=1.0)
    params: Optional[dict] = None


def _to_dict(sa: StyleArchive) -> dict:
    return {
        "id": sa.id,
        "project_id": sa.project_id,
        "name": sa.name,
        "description": sa.description or "",
        "ref_image_ids": sa.ref_image_ids or [],
        "strength_default": sa.strength_default,
        "params": sa.params or {},
        "created_at": sa.created_at.isoformat() if sa.created_at else None,
        "updated_at": sa.updated_at.isoformat() if sa.updated_at else None,
    }


@router.get("")
async def list_style_archives(
    project_id: str = Query(..., description="项目 id;必传"),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(StyleArchive)
        .where(StyleArchive.project_id == project_id)
        .order_by(StyleArchive.created_at.desc())
    )).scalars().all()
    return {"items": [_to_dict(r) for r in rows]}


@router.post("")
async def create_style_archive(
    body: StyleArchiveCreate,
    db: AsyncSession = Depends(get_db),
):
    sa = StyleArchive(
        project_id=body.project_id,
        name=body.name.strip(),
        description=body.description.strip(),
        ref_image_ids=body.ref_image_ids,
        strength_default=body.strength_default,
        params=body.params,
    )
    db.add(sa)
    await db.flush()
    await db.commit()
    return _to_dict(sa)


@router.get("/{archive_id}")
async def get_style_archive(
    archive_id: str,
    db: AsyncSession = Depends(get_db),
):
    sa = await db.get(StyleArchive, archive_id)
    if not sa:
        raise HTTPException(404, {"code": "not_found", "message": "风格档案不存在"})
    return _to_dict(sa)


@router.patch("/{archive_id}")
async def patch_style_archive(
    archive_id: str,
    body: StyleArchivePatch,
    db: AsyncSession = Depends(get_db),
):
    sa = await db.get(StyleArchive, archive_id)
    if not sa:
        raise HTTPException(404, {"code": "not_found", "message": "风格档案不存在"})
    if body.name is not None:
        sa.name = body.name.strip()
    if body.description is not None:
        sa.description = body.description.strip()
    if body.ref_image_ids is not None:
        sa.ref_image_ids = body.ref_image_ids
    if body.strength_default is not None:
        sa.strength_default = body.strength_default
    if body.params is not None:
        sa.params = body.params
    sa.updated_at = datetime.utcnow()
    await db.commit()
    return _to_dict(sa)


@router.delete("/{archive_id}")
async def delete_style_archive(
    archive_id: str,
    db: AsyncSession = Depends(get_db),
):
    sa = await db.get(StyleArchive, archive_id)
    if not sa:
        raise HTTPException(404, {"code": "not_found", "message": "风格档案不存在"})
    # 注意:删档案时,引用它的 strategies.style_archive_id 会变成悬空外键 —
    # Phase 1 不做级联,前端拉策略详情时 style_archive 取不到就当 None 处理。
    # Phase 2 如果要严格,可加 ON DELETE SET NULL 或拒绝删被引用的档案。
    await db.delete(sa)
    await db.commit()
    return {"ok": True}
