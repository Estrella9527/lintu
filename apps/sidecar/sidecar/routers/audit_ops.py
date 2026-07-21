"""操作审计读取端点 — `/api/audit/operations`。

OperationLogMiddleware 把所有写请求落到 operation_logs 表，这里给前端提供
分页 / 过滤的读 API。仅超级管理员可读（其他用户暂时看不到日志，避免横向
泄漏 — Phase 2 拆 admin 角色后再考虑放给项目管理员）。
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import OperationLog, User
from sidecar.db.session import get_db
from sidecar.time_utils import utc_iso

router = APIRouter()


def _require_root(request: Request) -> User:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, {"code": "unauthorized", "message": "请先登录"})
    if not getattr(user, "is_root", False):
        raise HTTPException(403, {"code": "forbidden", "message": "仅超级管理员可查看"})
    return user


@router.get("/operations")
async def list_operations(
    request: Request,
    user_id: Optional[str] = Query(None, description="只看某用户的操作"),
    project_id: Optional[str] = Query(None, description="只看某项目相关的写操作"),
    method: Optional[str] = Query(None, description="筛 method（POST/PUT/PATCH/DELETE）"),
    path_prefix: Optional[str] = Query(None, description="路径前缀模糊匹配，如 /api/images"),
    since: Optional[str] = Query(None, description="ISO 时间下界（含），早于此值的不返回"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    _require_root(request)

    q = select(OperationLog)
    if user_id:
        q = q.where(OperationLog.user_id == user_id)
    if project_id:
        q = q.where(OperationLog.project_id == project_id)
    if method:
        q = q.where(OperationLog.method == method.upper())
    if path_prefix:
        q = q.where(OperationLog.path.like(f"{path_prefix}%"))
    if since:
        try:
            cutoff = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(400, {"code": "invalid_since", "message": "since 必须是 ISO-8601 时间"})
        q = q.where(OperationLog.created_at >= cutoff)

    total = await db.scalar(select(OperationLog.id).where(q.whereclause).order_by(None)) if q.whereclause is not None else None  # noqa
    # 简单粗暴 count — 数据量大时可加专用 count 查询；Phase 1 单机够用
    rows = (await db.execute(
        q.order_by(desc(OperationLog.created_at)).offset(offset).limit(limit)
    )).scalars().all()

    # 顺手 batch 查 user.phone / display_name 让前端不必再请求
    user_ids = sorted({r.user_id for r in rows if r.user_id})
    users_map: dict[str, dict] = {}
    if user_ids:
        ulist = (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
        users_map = {u.id: {"phone": u.phone, "display_name": u.display_name} for u in ulist}

    return {
        "items": [
            {
                "id": r.id,
                "user_id": r.user_id,
                "user": users_map.get(r.user_id) if r.user_id else None,
                "project_id": r.project_id,
                "method": r.method,
                "path": r.path,
                "status_code": r.status_code,
                "summary": r.summary,
                "ip": r.ip,
                "user_agent": r.user_agent,
                "created_at": utc_iso(r.created_at),
            }
            for r in rows
        ],
        "limit": limit,
        "offset": offset,
        "next_offset": offset + len(rows) if len(rows) >= limit else None,
    }
