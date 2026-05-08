"""项目邀请路由（用户系统 Phase 1 · 决策 2-A 管理员输手机号邀请）。

简化模型：
  1. root（或项目内 admin，Phase 2 才区分）调 POST /api/projects/{pid}/invitations
     输入手机号 → 写 user_invitations 表（7 天有效）
  2. 不发独立邀请短信（避免新 SMS 模板审核流程）— 被邀请人下次用同手机号
     正常走 sms_verify 登录流时，sms_verify 自动检查 pending invitations 并
     auto-accept，把用户加进项目
  3. 管理员可以查看 pending 邀请列表 / 撤销

未来 Phase 2 扩展：
  - 单独的"邀请专属"短信模板 + token 链接接受流
  - 邮箱邀请
"""
from __future__ import annotations

import hashlib
import logging
import re
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import (
    Project, ProjectMember, User, UserInvitation,
)
from sidecar.db.session import get_db

logger = logging.getLogger(__name__)
router = APIRouter()

INVITATION_TTL_DAYS = 7
PHONE_REGEX = re.compile(r"^1[3-9]\d{9}$")


def _new_token() -> tuple[str, str]:
    raw = secrets.token_urlsafe(24)
    return raw, hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _require_root_or_member_admin(
    request: Request, project_id: str,
) -> User:
    """简化版权限：root 全权；普通用户 Phase 1 不能发邀请（Phase 2 拆 admin）。"""
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, {"code": "unauthorized", "message": "请先登录"})
    if not getattr(user, "is_root", False):
        raise HTTPException(403, {
            "code": "forbidden",
            "message": "仅超级管理员可邀请成员；后续拆分项目管理员角色后会开放",
        })
    return user


# ── 创建邀请 ───────────────────────────────────────────────────────────


class CreateInvitationBody(BaseModel):
    phone: str
    role: str = "member"


@router.post("/{project_id}/invitations")
async def create_invitation(
    project_id: str,
    body: CreateInvitationBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    me_user = _require_root_or_member_admin(request, project_id)

    phone = (body.phone or "").strip()
    if not PHONE_REGEX.match(phone):
        raise HTTPException(400, {"code": "invalid_phone", "message": "手机号格式不正确"})
    if body.role not in ("member",):  # Phase 1 只允许 member
        raise HTTPException(400, {"code": "invalid_role", "message": "Phase 1 仅支持 member 角色"})

    # 项目存在性
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, {"code": "not_found", "message": "项目不存在"})

    # 如果该手机号已经是项目成员 → 直接告知，不重复邀请
    existing_user = await db.scalar(select(User).where(User.phone == phone))
    if existing_user:
        existing_member = await db.scalar(
            select(ProjectMember)
            .where(ProjectMember.project_id == project_id)
            .where(ProjectMember.user_id == existing_user.id)
        )
        if existing_member:
            return {
                "ok": True,
                "already_member": True,
                "user_id": existing_user.id,
                "message": "该手机号已是项目成员",
            }

    # 撤销同手机号 + 同项目的旧 pending 邀请（避免堆积）
    old_pending = (await db.execute(
        select(UserInvitation)
        .where(UserInvitation.project_id == project_id)
        .where(UserInvitation.phone == phone)
        .where(UserInvitation.accepted_at.is_(None))
        .where(UserInvitation.expires_at > datetime.utcnow())
    )).scalars().all()
    for inv in old_pending:
        inv.expires_at = datetime.utcnow()    # 立即过期，等同撤销

    raw_token, token_hash = _new_token()
    inv = UserInvitation(
        project_id=project_id,
        phone=phone,
        role=body.role,
        token_hash=token_hash,
        invited_by=me_user.id,
        expires_at=datetime.utcnow() + timedelta(days=INVITATION_TTL_DAYS),
    )
    db.add(inv)
    await db.commit()
    await db.refresh(inv)

    # 不发额外短信（Phase 1 简化）— 直接告诉调用方"被邀请人下次正常登录会自动加入"
    return {
        "ok": True,
        "invitation_id": inv.id,
        "token": raw_token,           # 暂时返回；Phase 2 走专属短信再藏起来
        "expires_at": inv.expires_at.isoformat(),
        "auto_accept": True,
        "message": "邀请已创建。被邀请人下次用此手机号登录灵图时会自动加入此项目。",
    }


# ── 查询当前项目的待审邀请 ─────────────────────────────────────────────


@router.get("/{project_id}/invitations")
async def list_invitations(
    project_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    _require_root_or_member_admin(request, project_id)
    rows = (await db.execute(
        select(UserInvitation)
        .where(UserInvitation.project_id == project_id)
        .order_by(desc(UserInvitation.created_at))
        .limit(50)
    )).scalars().all()
    return [
        {
            "id": inv.id,
            "phone": inv.phone,
            "role": inv.role,
            "expires_at": inv.expires_at.isoformat() if inv.expires_at else None,
            "accepted_at": inv.accepted_at.isoformat() if inv.accepted_at else None,
            "created_at": inv.created_at.isoformat() if inv.created_at else None,
            "invited_by": inv.invited_by,
            "status": (
                "accepted" if inv.accepted_at
                else "expired" if (inv.expires_at and inv.expires_at < datetime.utcnow())
                else "pending"
            ),
        }
        for inv in rows
    ]


# ── 撤销邀请 ───────────────────────────────────────────────────────────


@router.delete("/{project_id}/invitations/{invitation_id}")
async def revoke_invitation(
    project_id: str,
    invitation_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    _require_root_or_member_admin(request, project_id)
    inv = await db.get(UserInvitation, invitation_id)
    if not inv or inv.project_id != project_id:
        raise HTTPException(404, {"code": "not_found", "message": "邀请不存在"})
    if inv.accepted_at is not None:
        return {"ok": True, "already_accepted": True}
    inv.expires_at = datetime.utcnow()
    await db.commit()
    return {"ok": True}


# ── 内部 helper：登录时 auto-accept pending invitations ─────────────────


async def auto_accept_pending_invitations(db: AsyncSession, user: User) -> int:
    """sms_verify 等登录端点调一下，把同手机号下所有 pending invitation 转成
    project_members。返回新加入的项目数。

    幂等：已是成员的不重复加；过期 / 已 accepted 的跳过。
    并发：同手机号同时多 tab 登录可能并发跑这个函数 — 我们 flush 一次拿到 PG
    侧的 IntegrityError（ProjectMember 有 (project_id, user_id) unique），把它
    catch 当成"另一个并发请求已经加进去了"处理。SQLite 行为类似（IntegrityError）。
    """
    if not user.phone:
        return 0
    from sqlalchemy.exc import IntegrityError

    pending = (await db.execute(
        select(UserInvitation)
        .where(UserInvitation.phone == user.phone)
        .where(UserInvitation.accepted_at.is_(None))
        .where(UserInvitation.expires_at > datetime.utcnow())
    )).scalars().all()

    added = 0
    now = datetime.utcnow()
    for inv in pending:
        existing = await db.scalar(
            select(ProjectMember)
            .where(ProjectMember.project_id == inv.project_id)
            .where(ProjectMember.user_id == user.id)
        )
        if existing:
            inv.accepted_at = now
            continue
        db.add(ProjectMember(
            project_id=inv.project_id,
            user_id=user.id,
            role=inv.role,
            invited_by=inv.invited_by,
        ))
        try:
            await db.flush()  # 立刻让 unique 约束兑现，避免后续 invitation 误以为成员未存在
        except IntegrityError:
            await db.rollback()
            inv.accepted_at = now
            continue
        inv.accepted_at = now
        added += 1
    return added
