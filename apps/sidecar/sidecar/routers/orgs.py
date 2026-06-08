"""组织 CRUD + 组织成员管理 — `/api/orgs/*`。

权限：
  - GET    /api/orgs                       任何登录用户（只列自己加入的组织）
  - GET    /api/orgs/{id}                  组织成员或 platform owner
  - POST   /api/orgs                       仅 platform owner
  - PATCH  /api/orgs/{id}                  org admin+
  - DELETE /api/orgs/{id}                  仅 platform owner（软删）
  - GET    /api/orgs/{id}/members          组织成员
  - POST   /api/orgs/{id}/members          org admin+
  - PATCH  /api/orgs/{id}/members/{uid}    org admin+
  - DELETE /api/orgs/{id}/members/{uid}    org admin+

owner 不可被 admin 改 / 踢；只有 platform owner 能动 owner。
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import desc, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.auth.roles import has_org_role
from sidecar.db.models import (
    Organization, OrganizationMember, Project, User,
)
from sidecar.db.session import get_db

logger = logging.getLogger(__name__)
router = APIRouter()

SLUG_REGEX = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")
PHONE_REGEX = re.compile(r"^1[3-9]\d{9}$")


# ── helpers ────────────────────────────────────────────────────────────


async def _sync_identity(
    org_ids: list[str] | None = None,
    user_ids: list[str] | None = None,
    org_member_ids: list[str] | None = None,
) -> None:
    """多设备同步(方案A):把身份层写操作 enqueue 到 cloud sync。
    cloud sync 未配置时各 enqueue 自动 no-op;失败不影响主流程。"""
    try:
        from sidecar.scheduler.cloud_sync_worker import (
            enqueue_org_upsert, enqueue_user_upsert, enqueue_org_member_upsert,
        )
        for oid in org_ids or []:
            await enqueue_org_upsert(oid)
        for uid in user_ids or []:
            await enqueue_user_upsert(uid)
        for mid in org_member_ids or []:
            await enqueue_org_member_upsert(mid)
    except Exception:
        logger.debug("[orgs] _sync_identity enqueue skipped", exc_info=True)


def _org_to_dict(o: Organization, member_count: int = 0, project_count: int = 0) -> dict:
    return {
        "id": o.id,
        "name": o.name,
        "slug": o.slug,
        "logo_url": o.logo_url,
        "contact_email": o.contact_email,
        "plan": o.plan,
        "storage_quota_gb": o.storage_quota_gb,
        "storage_used_gb": o.storage_used_gb,
        "status": o.status,
        "deleted_at": o.deleted_at.isoformat() if o.deleted_at else None,
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "member_count": member_count,
        "project_count": project_count,
    }


def _require_user(request: Request) -> User:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, {"code": "unauthorized", "message": "请先登录"})
    return user


def _is_platform_owner(user: User) -> bool:
    return bool(getattr(user, "is_platform_owner", False) or getattr(user, "is_root", False))


async def _require_org_role(
    request: Request, db: AsyncSession, org_id: str, required: str,
) -> tuple[User, Optional[OrganizationMember]]:
    """检查当前用户在 org_id 下的角色 ≥ required。返回 (user, member)。
    Platform owner 直接放行（member=None 表示隐式权限）。"""
    user = _require_user(request)
    if _is_platform_owner(user):
        return user, None

    member = await db.scalar(
        select(OrganizationMember)
        .where(OrganizationMember.org_id == org_id)
        .where(OrganizationMember.user_id == user.id)
    )
    if not member or not has_org_role(member.role, required):
        raise HTTPException(403, {
            "code": "forbidden",
            "message": f"该操作需要组织 {required} 角色",
            "current": member.role if member else None,
            "required": required,
        })
    return user, member


# ── 我所属的组织 / 我能创建的组织 ──────────────────────────────────────


@router.get("")
async def list_my_orgs(request: Request, db: AsyncSession = Depends(get_db)):
    """返回当前用户加入的所有组织。Platform owner 看全部 active 组织。"""
    user = _require_user(request)

    if _is_platform_owner(user):
        rows = (await db.execute(
            select(Organization).where(Organization.status == "active")
            .order_by(desc(Organization.created_at))
        )).scalars().all()
        my_role_map: dict[str, str] = {}
    else:
        # JOIN 拿到自己的角色
        result = (await db.execute(
            select(Organization, OrganizationMember.role)
            .join(OrganizationMember, OrganizationMember.org_id == Organization.id)
            .where(OrganizationMember.user_id == user.id)
            .where(Organization.status == "active")
            .order_by(desc(Organization.created_at))
        )).all()
        rows = [r[0] for r in result]
        my_role_map = {r[0].id: r[1] for r in result}

    # 顺手 batch 查 member / project count
    if rows:
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
    else:
        mem_counts = {}
        proj_counts = {}

    return [
        {
            **_org_to_dict(o, mem_counts.get(o.id, 0), proj_counts.get(o.id, 0)),
            "my_role": my_role_map.get(o.id) or ("platform_owner" if _is_platform_owner(user) else None),
        }
        for o in rows
    ]


@router.get("/{org_id}")
async def get_org(org_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user = _require_user(request)
    org = await db.get(Organization, org_id)
    if not org or org.status == "deleted":
        raise HTTPException(404, {"code": "not_found", "message": "组织不存在"})

    if not _is_platform_owner(user):
        member = await db.scalar(
            select(OrganizationMember)
            .where(OrganizationMember.org_id == org_id)
            .where(OrganizationMember.user_id == user.id)
        )
        if not member:
            raise HTTPException(404, {"code": "not_found", "message": "组织不存在"})

    mem_count = await db.scalar(
        select(func.count(OrganizationMember.id)).where(OrganizationMember.org_id == org_id)
    ) or 0
    proj_count = await db.scalar(
        select(func.count(Project.id)).where(Project.org_id == org_id)
    ) or 0
    return _org_to_dict(org, mem_count, proj_count)


# ── 创建 / 改 / 删 ──────────────────────────────────────────────────────


class CreateOrgBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    slug: str = Field(min_length=2, max_length=32)
    contact_email: Optional[str] = None
    initial_owner_phone: str
    plan: str = "free"


@router.post("")
async def create_org(
    body: CreateOrgBody, request: Request, db: AsyncSession = Depends(get_db),
):
    user = _require_user(request)
    if not _is_platform_owner(user):
        raise HTTPException(403, {"code": "forbidden", "message": "仅平台超级管理员可创建组织"})

    if not SLUG_REGEX.match(body.slug):
        raise HTTPException(400, {
            "code": "invalid_slug",
            "message": "slug 必须 2-32 字符，小写字母/数字/连字符，且头尾非连字符",
        })
    if not PHONE_REGEX.match(body.initial_owner_phone):
        raise HTTPException(400, {"code": "invalid_phone", "message": "手机号格式不正确"})
    if body.plan not in ("free", "pro", "enterprise"):
        raise HTTPException(400, {"code": "invalid_plan", "message": "套餐枚举非法"})

    # slug 全平台唯一
    existing = await db.scalar(select(Organization).where(Organization.slug == body.slug))
    if existing:
        raise HTTPException(409, {"code": "slug_taken", "message": "该 slug 已被占用"})

    quota = {"free": 10, "pro": 100, "enterprise": 1000}[body.plan]
    org = Organization(
        name=body.name,
        slug=body.slug,
        contact_email=body.contact_email,
        plan=body.plan,
        storage_quota_gb=quota,
    )
    db.add(org)
    await db.flush()

    # 找 / 建初始 owner user
    owner = await db.scalar(select(User).where(User.phone == body.initial_owner_phone))
    if owner is None:
        owner = User(phone=body.initial_owner_phone, status="active")
        db.add(owner)
        await db.flush()

    member = OrganizationMember(
        org_id=org.id, user_id=owner.id, role="owner", invited_by=user.id,
    )
    db.add(member)
    await db.commit()
    await db.refresh(org)
    await _sync_identity(org_ids=[org.id], user_ids=[owner.id], org_member_ids=[member.id])
    return _org_to_dict(org, 1, 0)


class UpdateOrgBody(BaseModel):
    name: Optional[str] = None
    contact_email: Optional[str] = None
    logo_url: Optional[str] = None


@router.patch("/{org_id}")
async def update_org(
    org_id: str, body: UpdateOrgBody, request: Request, db: AsyncSession = Depends(get_db),
):
    await _require_org_role(request, db, org_id, "admin")
    org = await db.get(Organization, org_id)
    if not org or org.status == "deleted":
        raise HTTPException(404, {"code": "not_found", "message": "组织不存在"})

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, {"code": "invalid_name", "message": "组织名称不能为空"})
        org.name = name
    if body.contact_email is not None:
        org.contact_email = body.contact_email.strip() or None
    if body.logo_url is not None:
        org.logo_url = body.logo_url.strip() or None

    await db.commit()
    await db.refresh(org)
    await _sync_identity(org_ids=[org.id])
    return _org_to_dict(org)


@router.delete("/{org_id}")
async def delete_org(org_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user = _require_user(request)
    if not _is_platform_owner(user):
        raise HTTPException(403, {"code": "forbidden", "message": "仅平台超级管理员可删除组织"})
    org = await db.get(Organization, org_id)
    if not org:
        raise HTTPException(404, {"code": "not_found", "message": "组织不存在"})
    org.status = "deleted"
    org.deleted_at = datetime.utcnow()
    await db.commit()
    # 软删:推 org upsert(status='deleted'),让其它设备看到状态变更(非物理删除,
    # 30 天可恢复,故走 upsert 而非 delete 墓碑)。
    await _sync_identity(org_ids=[org.id])
    return {"ok": True, "soft_deleted": True, "recoverable_until": (
        org.deleted_at.replace() if org.deleted_at else None
    )}


# ── 组织成员 ───────────────────────────────────────────────────────────


@router.get("/{org_id}/members")
async def list_org_members(
    org_id: str, request: Request, db: AsyncSession = Depends(get_db),
):
    # 必须是组织成员（或 platform owner）才能看
    user = _require_user(request)
    if not _is_platform_owner(user):
        is_member = await db.scalar(
            select(OrganizationMember.id)
            .where(OrganizationMember.org_id == org_id)
            .where(OrganizationMember.user_id == user.id)
        )
        if not is_member:
            raise HTTPException(404, {"code": "not_found", "message": "组织不存在"})

    rows = (await db.execute(
        select(OrganizationMember, User)
        .join(User, User.id == OrganizationMember.user_id)
        .where(OrganizationMember.org_id == org_id)
        .order_by(desc(OrganizationMember.created_at))
    )).all()
    return [
        {
            "id": m.id,
            "user_id": u.id,
            "phone": u.phone,
            "display_name": u.display_name,
            "avatar_url": u.avatar_url,
            "role": m.role,
            "invited_by": m.invited_by,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }
        for m, u in rows
    ]


class AddOrgMemberBody(BaseModel):
    phone: str
    role: str = "member"


@router.post("/{org_id}/members")
async def add_org_member(
    org_id: str, body: AddOrgMemberBody, request: Request, db: AsyncSession = Depends(get_db),
):
    await _require_org_role(request, db, org_id, "admin")
    if body.role not in ("admin", "member"):
        raise HTTPException(400, {"code": "invalid_role", "message": "只能赋 admin / member（owner 不可手动赋）"})
    if not PHONE_REGEX.match(body.phone):
        raise HTTPException(400, {"code": "invalid_phone", "message": "手机号格式不正确"})

    # 找/建 user
    user = await db.scalar(select(User).where(User.phone == body.phone))
    if user is None:
        user = User(phone=body.phone, status="active")
        db.add(user)
        await db.flush()

    # 已经是成员 → 返回原记录
    existing = await db.scalar(
        select(OrganizationMember)
        .where(OrganizationMember.org_id == org_id)
        .where(OrganizationMember.user_id == user.id)
    )
    if existing:
        return {
            "ok": True, "already_member": True,
            "user_id": user.id, "role": existing.role,
        }

    me = _require_user(request)
    member = OrganizationMember(
        org_id=org_id, user_id=user.id, role=body.role, invited_by=me.id,
    )
    db.add(member)
    await db.commit()
    await _sync_identity(user_ids=[user.id], org_member_ids=[member.id])
    return {"ok": True, "user_id": user.id, "phone": body.phone, "role": body.role}


class UpdateOrgMemberBody(BaseModel):
    role: str


@router.patch("/{org_id}/members/{user_id}")
async def update_org_member(
    org_id: str, user_id: str, body: UpdateOrgMemberBody,
    request: Request, db: AsyncSession = Depends(get_db),
):
    me, _ = await _require_org_role(request, db, org_id, "admin")
    target = await db.scalar(
        select(OrganizationMember)
        .where(OrganizationMember.org_id == org_id)
        .where(OrganizationMember.user_id == user_id)
    )
    if not target:
        raise HTTPException(404, {"code": "not_found", "message": "成员不存在"})

    # 不能把别人改成 owner
    if body.role not in ("admin", "member"):
        raise HTTPException(400, {"code": "invalid_role", "message": "只能改成 admin / member"})
    # owner 不能被 admin 降级
    if target.role == "owner" and not _is_platform_owner(me):
        raise HTTPException(403, {"code": "forbidden", "message": "owner 只能由平台超管修改"})

    target.role = body.role
    await db.commit()
    return {"ok": True, "user_id": user_id, "role": body.role}


@router.delete("/{org_id}/members/{user_id}")
async def remove_org_member(
    org_id: str, user_id: str, request: Request, db: AsyncSession = Depends(get_db),
):
    me, _ = await _require_org_role(request, db, org_id, "admin")
    target = await db.scalar(
        select(OrganizationMember)
        .where(OrganizationMember.org_id == org_id)
        .where(OrganizationMember.user_id == user_id)
    )
    if not target:
        raise HTTPException(404, {"code": "not_found", "message": "成员不存在"})
    if target.role == "owner" and not _is_platform_owner(me):
        raise HTTPException(403, {"code": "forbidden", "message": "不能踢 owner（仅平台超管可）"})
    if target.user_id == me.id:
        raise HTTPException(400, {"code": "cannot_remove_self", "message": "不能踢自己；先把 owner 转给别人"})

    await db.delete(target)
    # 顺手把该 user 在本组织所有项目的 ProjectMember 也清掉（防止越权残留）
    from sidecar.db.models import ProjectMember
    project_ids = (await db.execute(
        select(Project.id).where(Project.org_id == org_id)
    )).scalars().all()
    if project_ids:
        from sqlalchemy import delete as sql_delete
        await db.execute(
            sql_delete(ProjectMember)
            .where(ProjectMember.user_id == user_id)
            .where(ProjectMember.project_id.in_(project_ids))
        )
    await db.commit()
    return {"ok": True}
