"""多租户隔离 — ContextVar + SQLAlchemy do_orm_execute event。

把 "WHERE project_id IN (...)" 注入到所有 SELECT，让 150+ 端点无需逐个改造。
配套的 INSERT/UPDATE/DELETE 校验在 before_flush 里：写入的 project_id 必须
在 current_project_ids 内，否则 raise，防止越权写入。

不受隔离影响：
  - 全局表：prompts / strategies / tag_schema / synonyms / config / api_keys
            / users / sessions / project_members / config_audit_logs / ...
  - root user：current_project_ids 为空（middleware 不设），跳过过滤
  - 未鉴权场景：current_project_ids 默认空，等同 root（仅在 BYPASS / 系统级
                内部脚本场景出现）

注意事项：
  - **裸 SQL（`text(...)`）不被 hook 覆盖** — 必须显式带 project_id
  - **JOIN 时**主实体 entity 是 join 链的"主表"，hook 只对它生效
  - **before_flush** 拦截写入；如果业务希望某条 INSERT 跨租户，用 raw SQL 旁路
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Optional

from sqlalchemy import event
from sqlalchemy.orm import Session, with_loader_criteria

logger = logging.getLogger(__name__)


# ── ContextVars (request-scoped) ─────────────────────────────────────────
# 由 middleware/tenant.py 在每次请求开始时 set；endpoint 处理结束自动 reset。
current_user_id: ContextVar[Optional[str]] = ContextVar("current_user_id", default=None)
current_project_ids: ContextVar[list[str]] = ContextVar("current_project_ids", default=[])


# ── 受隔离保护的实体 ─────────────────────────────────────────────────────
# 用 with_loader_criteria 时必须给 ORM 类（不是 tablename）— 这样 SQLAlchemy
# 才能在 subquery / relationship loader / join 子句里同样注入条件。
def _tenant_model_classes() -> list[type]:
    """延迟 import 避免 db/tenant.py ↔ db/models.py 循环依赖。"""
    from sidecar.db.models import (
        BatchRun, BatchSubtask, DuplicateGroup, Image, MatchFeedback,
        OssSyncJob, PromptDoc, Task,
    )
    return [Image, Task, BatchRun, BatchSubtask, DuplicateGroup,
            MatchFeedback, OssSyncJob, PromptDoc]


TENANT_TABLES = frozenset({
    "images", "tasks", "batch_runs", "batch_subtasks",
    "duplicate_groups", "match_feedback", "oss_sync_jobs", "prompt_docs",
})


# ── SELECT 注入：do_orm_execute event ─────────────────────────────────────


def _inject_tenant_filter(execute_state):
    """对受 TENANT_TABLES 保护的 SELECT 自动加 WHERE project_id IN (...)。

    用 with_loader_criteria 而不是手动 .where：前者会渗透到
      - SELECT 顶层 entity
      - select_from(query.subquery()) 的内部 subquery（list endpoint 算 total
        的常见 pattern — 内层 select(Image) 仍然被加 where）
      - JOIN / relationship loader 引用同 entity 时
    手动 .where 只对顶层 column_descriptions 生效，会漏 subquery。

    边界：
      - non-SELECT → before_flush 管
      - 空 project_ids → root / 系统级，跳过
      - 个别端点想绕过（如 ops 维护脚本）→ statement.execution_options(
          tenant_bypass=True) 即可
    """
    if not execute_state.is_select:
        return
    if execute_state.execution_options.get("tenant_bypass"):
        return

    pids = current_project_ids.get()
    if not pids:
        return

    # ⚠️ 关键：with_loader_criteria 的 lambda 默认会被缓存（SQLAlchemy 用
    # closure variable 跟踪机制把 lambda 编成可复用 SQL）。如果用
    # default-arg 闭包 `lambda c, _p=tuple(pids)`，第一次 hook fire 后那个
    # 元组就被永久绑定到 cached SQL 的 IN 参数列表 → 后续不同租户请求复用
    # 该 cache → 严重越权。
    # 解法：track_closure_variables=False + track_bound_values=False 关掉
    # lambda 缓存。每次 hook fire 重新构建 IN (...) 表达式，pids 直接绑进
    # 字面参数列表（expanding bindparam）。性能损失可忽略 — 单次请求只构
    # 建一次。
    pids_tuple = tuple(pids)
    options = [
        with_loader_criteria(
            cls,
            lambda c: c.project_id.in_(pids_tuple),
            include_aliases=True,
            track_closure_variables=False,
        )
        for cls in _tenant_model_classes()
    ]
    execute_state.statement = execute_state.statement.options(*options)


# ── INSERT/UPDATE/DELETE 校验：before_flush event ────────────────────────


def _check_tenant_writes(session, flush_context, instances):
    """在 flush 前校验所有"新 / 改"对象的 project_id 都在用户授权范围内。

    DELETE 走 SELECT-then-delete 链路（SQLAlchemy 默认），SELECT 已经被注入
    过滤；如果用户访问不到那条记录，flush 时也不会出现在 deleted set。

    校验失败 → raise PermissionError，事务回滚。
    """
    pids = current_project_ids.get()
    if not pids:
        return

    pid_set = set(pids)

    for obj in list(session.new) + list(session.dirty):
        tablename = getattr(obj.__class__, "__tablename__", None)
        if tablename not in TENANT_TABLES:
            continue
        proj_id = getattr(obj, "project_id", None)
        if proj_id is None:
            # 写入时没设 project_id — 默认认为是越权（要求显式）
            raise PermissionError(
                f"tenant write rejected: {tablename}.project_id is None; "
                f"caller must set explicitly. allowed={list(pid_set)}"
            )
        if proj_id not in pid_set:
            raise PermissionError(
                f"tenant write rejected: {tablename}.project_id={proj_id!r} "
                f"not in caller's project_ids={list(pid_set)}"
            )


# ── 安装到 sessionmaker ──────────────────────────────────────────────────
# 在 db/session.py 之外通过 install_tenant_hooks(async_session) 调用一次。
_installed = False


def install_tenant_hooks(async_sessionmaker_factory) -> None:
    """挂钩到 sessionmaker — 每次创建 Session 都自动套上隔离逻辑。
    幂等：重复调用只首次生效。"""
    global _installed
    if _installed:
        return
    _installed = True

    # async_sessionmaker 内部使用同步 Session 类作为 sync_session_class；
    # do_orm_execute 和 before_flush 都是 sync session 的事件。
    # kw.get 默认 None；当未显式传时 SQLAlchemy 内部用默认 Session。
    sync_session_class = async_sessionmaker_factory.kw.get("sync_session_class") or Session

    event.listen(sync_session_class, "do_orm_execute", _inject_tenant_filter)
    event.listen(sync_session_class, "before_flush", _check_tenant_writes)

    # 用 print + flush — 在 sidecar subprocess 里 logging.basicConfig 经常被
    # uvicorn 接管，logger.info 不一定可见；print 强制可见用于诊断。
    print(f"[tenant] hooks installed on {sync_session_class.__name__}; "
          f"protected={sorted(TENANT_TABLES)}", flush=True)
    logger.info("[tenant] hooks installed; protected tables = %s", sorted(TENANT_TABLES))
