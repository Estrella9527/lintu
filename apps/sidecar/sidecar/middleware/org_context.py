"""OrgContextMiddleware — 根据请求推断 active org + role，并缓存到 request.state。

执行顺序：UserAuthMiddleware → **OrgContextMiddleware** → TenantMiddleware → endpoint

工作内容：
  1. 从请求里拿 active_org_id：
     - 优先：path 参数 `/api/orgs/{org_id}/...`
     - 其次：header `X-Org-Id`
     - 兜底：用户的"主组织"（OrganizationMember 里 role 最高的那个；并列时取最早创建的）
  2. 从 OrganizationMember 查 user 在该 org 的 role → request.state.org_role
  3. 如果路径含 project_id 参数：从 ProjectMember 查 user 的 project_role；
     组织 owner/admin 自动获得 project_admin 等价权限（不查 ProjectMember 表）

未登录 / SYSTEM_ROOT 旁路：不查表，跳过；后续装饰器看到 user.is_platform_owner=True 直接放行。
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from fastapi import Request
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)


# 简单的 path 解析器：抓 /api/orgs/{id}/... 和 /api/projects/{id}/... 里的 id
_ORG_ID_PATH_RE = re.compile(r"^/api/orgs/([^/]+)")
_PROJECT_ID_PATH_RE = re.compile(r"^/api/projects/([^/]+)")


def _project_id_from_path_or_query(request: Request) -> Optional[str]:
    """优先 path /api/projects/{id}，其次 query ?project_id=xxx。"""
    m = _PROJECT_ID_PATH_RE.match(request.url.path)
    if m:
        return m.group(1)
    return request.query_params.get("project_id")


def _org_id_from_path(request: Request) -> Optional[str]:
    m = _ORG_ID_PATH_RE.match(request.url.path)
    return m.group(1) if m else None


async def _user_primary_org_id(user_id: str) -> Optional[str]:
    """用户的主组织 — owner > admin > member，并列时取最早 created_at。"""
    from sidecar.db.models import OrganizationMember
    from sidecar.db.session import async_session
    from sqlalchemy import case

    role_rank = case(
        {"owner": 2, "admin": 1, "member": 0},
        value=OrganizationMember.role,
        else_=0,
    )
    async with async_session() as db:
        row = (await db.execute(
            select(OrganizationMember.org_id, role_rank.label("rank"))
            .where(OrganizationMember.user_id == user_id)
            .order_by(role_rank.desc(), OrganizationMember.created_at.asc())
            .limit(1)
        )).first()
    return row[0] if row else None


async def _resolve_org_role(user_id: str, org_id: str) -> Optional[str]:
    from sidecar.db.models import OrganizationMember
    from sidecar.db.session import async_session
    async with async_session() as db:
        row = await db.scalar(
            select(OrganizationMember.role)
            .where(OrganizationMember.user_id == user_id)
            .where(OrganizationMember.org_id == org_id)
        )
    return row


async def _resolve_project_role(user_id: str, project_id: str) -> Optional[str]:
    from sidecar.db.models import ProjectMember
    from sidecar.db.session import async_session
    async with async_session() as db:
        row = await db.scalar(
            select(ProjectMember.role)
            .where(ProjectMember.user_id == user_id)
            .where(ProjectMember.project_id == project_id)
        )
    return row


class OrgContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method == "OPTIONS":
            return await call_next(request)

        user = getattr(request.state, "user", None)

        # 未登录 / SYSTEM_ROOT 旁路 → 直接走，下游 capability 装饰器看 is_platform_owner
        if user is None or getattr(user, "is_root", False) or getattr(user, "is_platform_owner", False):
            return await call_next(request)

        # ── 解析 active_org_id ─────────────────────────────────
        org_id = _org_id_from_path(request) or request.headers.get("x-org-id")
        if not org_id:
            org_id = await _user_primary_org_id(user.id)

        if org_id:
            request.state.active_org_id = org_id
            request.state.org_role = await _resolve_org_role(user.id, org_id)

        # ── 解析 project_role（如果路径含 project_id） ────────
        project_id = _project_id_from_path_or_query(request)
        if project_id:
            project_role = await _resolve_project_role(user.id, project_id)
            # 组织 owner/admin 隐式获得 project_admin 权限
            if not project_role and request.state.__dict__.get("org_role") in ("owner", "admin"):
                project_role = "project_admin"
            request.state.project_role = project_role

        return await call_next(request)
