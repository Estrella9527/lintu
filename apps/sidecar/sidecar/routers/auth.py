"""用户系统 Phase 1 — 登录注册端点。

挂在 /api/auth/* 下；UserAuthMiddleware 会跳过这一前缀（没登录也能访问）。

PR-2：手机号验证码 + token 颁发 + me / logout / refresh
（邮箱密码 / 微信扫码已删 — 决定先用最简单的手机号通道，后续视需要再补）
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
    Project, ProjectMember, Session as UserSession, SmsCode, User,
)
from sidecar.db.session import get_db
from sidecar.providers import sms_aliyun

logger = logging.getLogger(__name__)
router = APIRouter()


# ── 配置 ────────────────────────────────────────────────────────────────
SMS_CODE_TTL_SEC = 5 * 60          # 验证码 5 分钟过期
SMS_RESEND_COOLDOWN_SEC = 60       # 同手机号 60 秒只能发一次
SMS_MAX_ATTEMPTS = 3               # 单条 code 最多输错 3 次（同 code 复用 attempts）
SESSION_TTL_DAYS = 30              # session 30 天有效

# 国内 11 位手机号（粗略；不做运营商精检）
PHONE_REGEX = re.compile(r"^1[3-9]\d{9}$")


# ── 工具函数 ────────────────────────────────────────────────────────────
def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_token() -> tuple[str, str]:
    """生成不透明 token + 它的 sha256。落盘只存 hash，原始返回给客户端。"""
    raw = secrets.token_urlsafe(32)   # 43 字符 base64
    return raw, _hash_token(raw)


def _new_code_id() -> str:
    import uuid
    return str(uuid.uuid4())


async def _create_session(
    db: AsyncSession, user: User, *, request: Request,
) -> tuple[str, UserSession]:
    """颁发一个新 session — 落 sha256，返回原始 token + Session 对象。"""
    raw, h = _new_token()
    sess = UserSession(
        user_id=user.id,
        token_hash=h,
        device_label=(request.headers.get("x-device-label") or "")[:80],
        ip=(request.client.host if request.client else "")[:64],
        user_agent=(request.headers.get("user-agent") or "")[:200],
        expires_at=datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS),
    )
    db.add(sess)
    user.last_login_at = datetime.utcnow()
    await db.flush()
    return raw, sess


async def _user_payload(db: AsyncSession, user: User) -> dict:
    """组装 /me 响应。包含 user 基本信息 + 加入的 project 列表（id+name）。"""
    rows = (await db.execute(
        select(ProjectMember.project_id, ProjectMember.role, Project.name, Project.color)
        .join(Project, Project.id == ProjectMember.project_id)
        .where(ProjectMember.user_id == user.id)
    )).all()
    return {
        "id": user.id,
        "phone": user.phone,
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
        "is_root": bool(user.is_root),
        "is_platform_owner": bool(getattr(user, "is_platform_owner", False)),
        "projects": [
            {"id": pid, "name": pname, "color": pcolor, "role": role}
            for pid, role, pname, pcolor in rows
        ],
    }


# ── 手机号验证码登录 ────────────────────────────────────────────────────


class SmsSendBody(BaseModel):
    phone: str


@router.post("/sms/send")
async def sms_send(body: SmsSendBody, db: AsyncSession = Depends(get_db)):
    phone = (body.phone or "").strip()
    if not PHONE_REGEX.match(phone):
        raise HTTPException(400, {"code": "invalid_phone", "message": "手机号格式不正确"})

    # 60 秒冷却：查最近一条同手机号 code
    cutoff = datetime.utcnow() - timedelta(seconds=SMS_RESEND_COOLDOWN_SEC)
    recent = await db.scalar(
        select(SmsCode)
        .where(SmsCode.phone == phone)
        .where(SmsCode.created_at >= cutoff)
        .order_by(desc(SmsCode.created_at))
        .limit(1)
    )
    if recent:
        wait = SMS_RESEND_COOLDOWN_SEC - int((datetime.utcnow() - recent.created_at).total_seconds())
        raise HTTPException(429, {
            "code": "rate_limited",
            "message": f"请 {max(1, wait)} 秒后再试",
            "retry_after": max(1, wait),
        })

    code = sms_aliyun.generate_code(6)
    sms_row = SmsCode(
        id=_new_code_id(),
        phone=phone,
        code=code,
        expires_at=datetime.utcnow() + timedelta(seconds=SMS_CODE_TTL_SEC),
    )
    db.add(sms_row)
    await db.commit()

    ok, err = await sms_aliyun.send_code(phone, code)
    if not ok:
        raise HTTPException(502, {
            "code": "sms_send_failed",
            "message": err or "短信发送失败",
        })
    return {"ok": True, "ttl_sec": SMS_CODE_TTL_SEC}


class SmsVerifyBody(BaseModel):
    phone: str
    code: str


@router.post("/sms/verify")
async def sms_verify(body: SmsVerifyBody, request: Request, db: AsyncSession = Depends(get_db)):
    phone = (body.phone or "").strip()
    code = (body.code or "").strip()
    if not PHONE_REGEX.match(phone) or not re.match(r"^\d{4,8}$", code):
        raise HTTPException(400, {"code": "invalid_request", "message": "手机号或验证码格式不正确"})

    # 取最近一条未使用、未过期的 code
    sms_row = await db.scalar(
        select(SmsCode)
        .where(SmsCode.phone == phone)
        .where(SmsCode.used == False)
        .where(SmsCode.expires_at > datetime.utcnow())
        .order_by(desc(SmsCode.created_at))
        .limit(1)
    )
    if not sms_row:
        raise HTTPException(400, {"code": "code_expired", "message": "验证码已过期或不存在，请重新获取"})

    # 防爆破：错 3 次该条 code 失效
    if sms_row.attempts >= SMS_MAX_ATTEMPTS:
        sms_row.used = True
        await db.commit()
        raise HTTPException(400, {"code": "code_locked", "message": "验证码错误次数过多，请重新获取"})

    if sms_row.code != code:
        sms_row.attempts += 1
        await db.commit()
        raise HTTPException(400, {
            "code": "code_mismatch",
            "message": "验证码错误",
            "attempts_left": SMS_MAX_ATTEMPTS - sms_row.attempts,
        })

    # 验证成功：标记 used
    sms_row.used = True

    # 找/建用户
    user = await db.scalar(select(User).where(User.phone == phone))
    if user is None:
        user = User(phone=phone, status="active")
        db.add(user)
        await db.flush()
        logger.info("[auth] new user via sms: id=%s phone=%s", user.id, phone)
    elif user.status == "disabled":
        raise HTTPException(403, {"code": "user_disabled", "message": "账号已被禁用"})

    # 自动接受同手机号下所有 pending invitations — 一登入立刻挂项目
    from sidecar.routers.invitations import auto_accept_pending_invitations
    accepted = await auto_accept_pending_invitations(db, user)
    if accepted > 0:
        logger.info("[auth] auto-accepted %d invitations for user %s", accepted, user.id)

    raw_token, _sess = await _create_session(db, user, request=request)
    await db.commit()

    return {
        "token": raw_token,
        "user": await _user_payload(db, user),
        "auto_accepted_invitations": accepted,
    }


# ── 通用：me / logout / refresh ────────────────────────────────────────


def _bearer(request: Request) -> Optional[str]:
    h = request.headers.get("authorization") or ""
    if h.lower().startswith("bearer "):
        return h[7:].strip() or None
    return None


async def _require_user(request: Request, db: AsyncSession) -> User:
    """直接校验 token（auth router 自身不挂 UserAuthMiddleware）。"""
    # 兼容：UserAuthMiddleware 已设了就直接用
    state_user = getattr(request.state, "user", None)
    if state_user is not None:
        return state_user
    token = _bearer(request)
    if not token:
        raise HTTPException(401, {"code": "unauthorized", "message": "请先登录"})
    h = _hash_token(token)
    sess = await db.scalar(
        select(UserSession)
        .where(UserSession.token_hash == h)
        .where(UserSession.expires_at > datetime.utcnow())
        .where(UserSession.revoked_at.is_(None))
    )
    if not sess:
        raise HTTPException(401, {"code": "token_invalid", "message": "登录已过期，请重新登录"})
    user = await db.get(User, sess.user_id)
    if not user or user.status != "active":
        raise HTTPException(403, {"code": "user_disabled", "message": "账号不可用"})
    return user


@router.get("/me")
async def me(request: Request, db: AsyncSession = Depends(get_db)):
    user = await _require_user(request, db)
    return await _user_payload(db, user)


class UpdateMeBody(BaseModel):
    """改自己的资料 — Phase 1 只支持昵称、头像。手机号修改要走专门的换绑流程。"""
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None


@router.patch("/me")
async def update_me(
    body: UpdateMeBody, request: Request, db: AsyncSession = Depends(get_db),
):
    me = await _require_user(request, db)
    # SYSTEM_ROOT 旁路 user 是虚拟 dataclass，没法保存 — 直接拒绝
    if not hasattr(me, "__tablename__"):
        raise HTTPException(400, {
            "code": "ephemeral_user",
            "message": "当前会话是 ops/dev bypass 旁路用户，不能改资料",
        })

    # ⚠️ UserAuthMiddleware 用的是独立 DB session 加载 me，跟当前请求的 db
    # 不是同一个 Session — 直接改 me.display_name 然后 db.commit() 会报
    # "Instance is not persistent within this Session"。
    # 重新在当前 db 里 get 一次，拿到 attached 的实例再改。
    user = await db.get(User, me.id)
    if user is None:
        raise HTTPException(404, {"code": "user_not_found", "message": "用户已不存在"})

    if body.display_name is not None:
        name = body.display_name.strip()
        if len(name) > 32:
            raise HTTPException(400, {"code": "name_too_long", "message": "昵称最多 32 字符"})
        user.display_name = name or None
    if body.avatar_url is not None:
        url = body.avatar_url.strip()
        user.avatar_url = url or None

    await db.commit()
    await db.refresh(user)
    return await _user_payload(db, user)


@router.post("/logout")
async def logout(request: Request, db: AsyncSession = Depends(get_db)):
    token = _bearer(request)
    if not token:
        return {"ok": True}   # 已经没登录
    h = _hash_token(token)
    sess = await db.scalar(select(UserSession).where(UserSession.token_hash == h))
    if sess and sess.revoked_at is None:
        sess.revoked_at = datetime.utcnow()
        await db.commit()
    return {"ok": True}


@router.post("/refresh")
async def refresh(request: Request, db: AsyncSession = Depends(get_db)):
    """滚动延期：当前 token 仍有效就把 expires_at 推到 now+30d，不换 token。
    避免桌面 app 在 30 天内强制重登。"""
    user = await _require_user(request, db)
    token = _bearer(request)
    h = _hash_token(token) if token else None
    if not h:
        raise HTTPException(401, {"code": "token_invalid", "message": "无 token"})
    sess = await db.scalar(select(UserSession).where(UserSession.token_hash == h))
    if not sess:
        raise HTTPException(401, {"code": "token_invalid", "message": "无 token"})
    sess.expires_at = datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS)
    await db.commit()
    return {"ok": True, "expires_at": sess.expires_at.isoformat()}


# ── 设备 / 会话管理 ─────────────────────────────────────────────────────


@router.get("/sessions")
async def list_sessions(request: Request, db: AsyncSession = Depends(get_db)):
    """列出当前用户的所有有效 session — 多设备登录场景下让用户看到自己在
    哪些机器登录了，同时提供 revoke 入口。"""
    user = await _require_user(request, db)
    cur_token = _bearer(request)
    cur_hash = _hash_token(cur_token) if cur_token else None
    rows = (await db.execute(
        select(UserSession)
        .where(UserSession.user_id == user.id)
        .where(UserSession.revoked_at.is_(None))
        .where(UserSession.expires_at > datetime.utcnow())
        .order_by(desc(UserSession.created_at))
    )).scalars().all()
    return [
        {
            "id": s.id,
            "device_label": s.device_label or None,
            "ip": s.ip or None,
            "user_agent": s.user_agent or None,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
            "is_current": s.token_hash == cur_hash,
        }
        for s in rows
    ]


@router.delete("/sessions/{session_id}")
async def revoke_session(
    session_id: str, request: Request, db: AsyncSession = Depends(get_db),
):
    """踢掉某个设备的登录态。本设备的 session 也允许踢（等效 logout）。"""
    user = await _require_user(request, db)
    sess = await db.get(UserSession, session_id)
    if not sess or sess.user_id != user.id:
        raise HTTPException(404, {"code": "not_found", "message": "session 不存在"})
    if sess.revoked_at is None:
        sess.revoked_at = datetime.utcnow()
        await db.commit()
    return {"ok": True}


