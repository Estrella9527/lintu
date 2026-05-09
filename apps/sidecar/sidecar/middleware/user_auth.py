"""User auth middleware — /api/* 端点的 token 验证。

行为矩阵（取决于 BUILD_FLAVOR + LINTU_AUTH_BYPASS）：

  user 版    → 强制登录；未带 token / token 无效 → 401（除登录端点）
  ops 版     → 自动注入 SYSTEM_ROOT_PRINCIPAL（虚拟 root）；不弹登录页
  dev 版     → 默认强制登录；export LINTU_AUTH_BYPASS=1 后等同 ops

不影响：
  /open-api/v1/*  → AuthMiddleware（ApiKey 路径，已有，不动）
  /internal/sync/* → require_sync_token（已有，不动）
  /api/auth/*     → 登录端点本身不需要鉴权
  /api/healthz, / → 公开
"""
from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


# 这些前缀即使没 token 也放行 — 仅短信发码/验证（登录入口）。
# /api/auth/me, /logout, /refresh, /sessions 都应该走鉴权（或 bypass 注入 root），
# 不能放在这里，否则 ops/dev BYPASS 模式下这些端点拿不到 request.state.user。
PUBLIC_API_PREFIXES = (
    "/api/auth/sms/",
)

PUBLIC_API_PATHS = {
    "/api/healthz",
    "/health",
    "/",
}

# 只对这些前缀鉴权；其余路径（如 /open-api/v1/*）走原有的 AuthMiddleware
PROTECTED_PREFIXES = ("/api/",)


@dataclass
class _RootPrincipal:
    """虚拟 root user，用于 ops flavor / LINTU_AUTH_BYPASS。
    跟真实 User 结构兼容（is_root=True 即可让下游全集查询）。"""
    id: str = "system-root"
    phone: Optional[str] = None
    display_name: str = "超级管理员"
    status: str = "active"
    is_root: bool = True
    is_platform_owner: bool = True
    avatar_url: Optional[str] = None


SYSTEM_ROOT = _RootPrincipal()


def _flavor() -> str:
    """读启动时主进程注入的 LINTU_BUILD_FLAVOR。Sidecar 单跑（命令行）也支持
    手动 export — 测试 / CLI 工具场景下可显式控制行为。"""
    v = (os.environ.get("LINTU_BUILD_FLAVOR") or "").lower()
    if v in ("dev", "user", "ops"):
        return v
    return "dev"   # 单跑时按 dev 处理（默认严格鉴权，可加 BYPASS 跳过）


def _bypass_enabled() -> bool:
    return os.environ.get("LINTU_AUTH_BYPASS", "").strip() in ("1", "true", "yes", "on")


def _is_protected_path(path: str) -> bool:
    if path in PUBLIC_API_PATHS:
        return False
    if any(path.startswith(p) for p in PUBLIC_API_PREFIXES):
        return False
    return any(path.startswith(p) for p in PROTECTED_PREFIXES)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _bearer(request: Request) -> Optional[str]:
    """提取 token：Authorization 头优先；GET 请求兜底 ?token= query。

    GET 才接受 query token，是为了支持 <img src=> / EventSource / <a download>
    这类原生标签 — 它们没法塞自定义请求头。**写操作（POST/PUT/PATCH/DELETE）
    禁用 query token**：referer / 浏览器 history 会记 URL，写操作走 query
    token 等于把"操作能力"贴到链接上，未来某个 markdown / 钉钉转发就能 CSRF
    出去。读操作风险低（最坏只是泄漏看图能力）。

    桌面端 Electron 单机环境其实都不严重，但服务端模式（LINTU_MODE=server）
    上线后这个分级是必需的。
    """
    h = request.headers.get("authorization") or ""
    if h.lower().startswith("bearer "):
        return h[7:].strip() or None
    if request.method == "GET":
        qt = request.query_params.get("token")
        if qt:
            return qt.strip() or None
    return None


def _401(message: str = "请先登录") -> JSONResponse:
    return JSONResponse(
        {"detail": {"code": "unauthorized", "message": message}},
        status_code=401,
    )


class UserAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # CORS preflight 不带 Authorization 头，必须放过让 CORSMiddleware 处理。
        # 否则浏览器看到 OPTIONS → 401 → 判定 CORS 错误 → fetch 失败 → 前端
        # 反复 retry 形成请求风暴。所有跨域 fetch 都受影响（dev 时 localhost:5173 → 7879）。
        if request.method == "OPTIONS":
            return await call_next(request)

        path = request.url.path

        if not _is_protected_path(path):
            return await call_next(request)

        # ops 自动派 root；dev 看 LINTU_AUTH_BYPASS env；user 物理屏蔽 BYPASS
        # （即使客户机自己 set LINTU_AUTH_BYPASS=1 也拒绝跳过登录 — 跟
        # cloud sync env 同级别保护，user 版打包永远不能被 env 提权）
        flavor = _flavor()
        if flavor == "ops":
            request.state.user = SYSTEM_ROOT
            return await call_next(request)
        if flavor == "dev" and _bypass_enabled():
            request.state.user = SYSTEM_ROOT
            return await call_next(request)

        token = _bearer(request)
        if not token:
            return _401("请先登录")

        # 异步上下文里查 sessions 表 — 用独立 session 避免污染 endpoint 自己的
        from sidecar.db.models import Session as UserSession, User
        from sidecar.db.session import async_session

        async with async_session() as db:
            sess = await db.scalar(
                select(UserSession)
                .where(UserSession.token_hash == _hash_token(token))
                .where(UserSession.expires_at > datetime.utcnow())
                .where(UserSession.revoked_at.is_(None))
            )
            if not sess:
                return _401("登录已过期，请重新登录")
            user = await db.get(User, sess.user_id)
            if not user or user.status != "active":
                return _401("账号不可用")

        request.state.user = user
        return await call_next(request)
