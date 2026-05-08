"""平台管理端点 — `/api/platform/*`。

仅 platform owner 可用。提供：
  - 全平台组织 / 用户 / 用量概览
  - 跨组织运维（已 break-glass 进 audit log）
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import (
    Image, Organization, OrganizationMember, Project, User,
)
from sidecar.db.session import get_db

router = APIRouter()


def _require_platform_owner(request: Request) -> User:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, {"code": "unauthorized", "message": "请先登录"})
    if not (getattr(user, "is_platform_owner", False) or getattr(user, "is_root", False)):
        raise HTTPException(403, {"code": "forbidden", "message": "仅平台超级管理员可访问"})
    return user


@router.get("/overview")
async def platform_overview(request: Request, db: AsyncSession = Depends(get_db)):
    _require_platform_owner(request)
    org_count = await db.scalar(
        select(func.count(Organization.id)).where(Organization.status == "active")
    ) or 0
    user_count = await db.scalar(select(func.count(User.id))) or 0
    image_count = await db.scalar(select(func.count(Image.id))) or 0
    project_count = await db.scalar(select(func.count(Project.id))) or 0
    storage_total = await db.scalar(
        select(func.coalesce(func.sum(Organization.storage_used_gb), 0))
        .where(Organization.status == "active")
    ) or 0
    return {
        "org_count": org_count,
        "user_count": user_count,
        "image_count": image_count,
        "project_count": project_count,
        "storage_used_gb": float(storage_total),
    }


@router.get("/orgs")
async def list_all_orgs(request: Request, db: AsyncSession = Depends(get_db)):
    """所有组织（含 deleted），用于平台运维。"""
    _require_platform_owner(request)
    rows = (await db.execute(
        select(Organization).order_by(desc(Organization.created_at))
    )).scalars().all()

    if not rows:
        return []
    ids = [o.id for o in rows]
    mem_counts = dict((await db.execute(
        select(OrganizationMember.org_id, func.count(OrganizationMember.id))
        .where(OrganizationMember.org_id.in_(ids))
        .group_by(OrganizationMember.org_id)
    )).all())
    proj_counts = dict((await db.execute(
        select(Project.org_id, func.count(Project.id))
        .where(Project.org_id.in_(ids))
        .group_by(Project.org_id)
    )).all())

    return [
        {
            "id": o.id,
            "name": o.name,
            "slug": o.slug,
            "plan": o.plan,
            "status": o.status,
            "storage_quota_gb": o.storage_quota_gb,
            "storage_used_gb": o.storage_used_gb,
            "created_at": o.created_at.isoformat() if o.created_at else None,
            "deleted_at": o.deleted_at.isoformat() if o.deleted_at else None,
            "member_count": mem_counts.get(o.id, 0),
            "project_count": proj_counts.get(o.id, 0),
        }
        for o in rows
    ]


@router.get("/users")
async def list_all_users(request: Request, db: AsyncSession = Depends(get_db)):
    """所有用户。"""
    _require_platform_owner(request)
    rows = (await db.execute(
        select(User).order_by(desc(User.created_at))
    )).scalars().all()
    return [
        {
            "id": u.id,
            "phone": u.phone,
            "display_name": u.display_name,
            "is_platform_owner": bool(u.is_platform_owner),
            "is_root": bool(u.is_root),
            "status": u.status,
            "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in rows
    ]
