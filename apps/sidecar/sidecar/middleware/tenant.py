"""Tenant middleware — 把当前 user 的 project_ids 注入 ContextVar。

执行顺序：UserAuthMiddleware (set request.state.user) → TenantMiddleware
（这里）→ endpoint。

行为：
  - request.state.user 不存在 → 跳过（保持空 project_ids，全集模式）
  - user.is_root → 跳过（root 看全部）
  - 普通 user → 查 project_members 拿到 project_ids，set ContextVar
  - 请求结束 → reset ContextVar（避免泄漏到下一请求）
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import Request
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware

from sidecar.db.tenant import current_project_ids, current_user_id

logger = logging.getLogger(__name__)


# 短缓存 user_id → project_ids，避免每请求查 project_members（毫秒级开销，但
# 本机高频请求场景下还是省一点）。10 秒过期：发邀请加成员场景能在 10s 内生效。
# 加 max-size 简单上限：防止长时间运行后字典无限累积（每次写入触发一次 sweep
# 把过期条目清掉；用户不会同时有 1000+ 在线，512 上限够用）。
_CACHE_TTL_SEC = 10
_CACHE_MAX_SIZE = 512
_pids_cache: dict[str, tuple[list[str], float]] = {}


def _sweep_pids_cache(now: float) -> None:
    """删掉所有过期条目；如果还超 max，按时间顺序砍最老的。"""
    expired = [k for k, (_pids, ts) in _pids_cache.items() if (now - ts) >= _CACHE_TTL_SEC]
    for k in expired:
        _pids_cache.pop(k, None)
    if len(_pids_cache) > _CACHE_MAX_SIZE:
        # 按 ts 升序砍最早的，留最新 _CACHE_MAX_SIZE 个
        items = sorted(_pids_cache.items(), key=lambda kv: kv[1][1])
        for k, _v in items[: len(_pids_cache) - _CACHE_MAX_SIZE]:
            _pids_cache.pop(k, None)


async def _fetch_project_ids(user_id: str) -> list[str]:
    """从 project_members 取该用户加入的所有 project_id。"""
    import time
    now = time.time()
    cached = _pids_cache.get(user_id)
    if cached and (now - cached[1]) < _CACHE_TTL_SEC:
        return cached[0]

    from sidecar.db.models import ProjectMember
    from sidecar.db.session import async_session

    async with async_session() as db:
        rows = (await db.execute(
            select(ProjectMember.project_id).where(ProjectMember.user_id == user_id)
        )).all()
    pids = [r[0] for r in rows]
    _pids_cache[user_id] = (pids, now)
    _sweep_pids_cache(now)
    return pids


def invalidate_project_ids_cache(user_id: Optional[str] = None) -> None:
    """加成员 / 移成员时调一下，避免 10s 期间用户看不到 / 仍能看到。
    user_id=None 清全部。"""
    if user_id is None:
        _pids_cache.clear()
    else:
        _pids_cache.pop(user_id, None)


class TenantMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        user = getattr(request.state, "user", None)

        if user is None or getattr(user, "is_root", False):
            # 没登录 → 系统级（全集）；root → 全集
            # 都不 set ContextVar，保持默认空，hook 跳过
            return await call_next(request)

        pids = await _fetch_project_ids(user.id)
        token_uid = current_user_id.set(user.id)
        token_pids = current_project_ids.set(pids)
        try:
            return await call_next(request)
        finally:
            current_user_id.reset(token_uid)
            current_project_ids.reset(token_pids)
