"""角色与权限模型 — v0.2。

定义两组角色枚举（org / project），以及一个 require_role 装饰器，让端点可以
声明式表达"我至少要 editor 才能调"。

一致性原则：
  - **更高的角色覆盖更低的角色**（owner 能干 admin 能干 member 能干的）
  - **平台 owner 隐式获得所有组织 owner 权限**（跨组织运维）
  - **组织 admin 隐式获得所有组织内项目的 project_admin 权限**（不需要单独加 ProjectMember）

这样用户感知是「我的最大角色决定了我能干什么」，不需要 mental model 跑两遍。
"""
from __future__ import annotations

from functools import wraps
from typing import Callable, Optional

from fastapi import HTTPException, Request


# ── 组织角色枚举（强弱排序） ───────────────────────────────────────────
ORG_ROLE_RANK = {
    "member": 0,
    "admin":  1,
    "owner":  2,
}


# ── 项目角色枚举（强弱排序） ───────────────────────────────────────────
# labeler 是横向角色（看 + 审核打标），不在主线弱→强排序里；用单独 ALLOW
PROJECT_ROLE_RANK = {
    "viewer":        0,
    "labeler":       0,   # 跟 viewer 同级（都不能改写主流程数据）
    "editor":        1,
    "project_admin": 2,
}


# ── 业务能力 → 最低需要的角色 ─────────────────────────────────────────
# 端点级 @require_role 用这个表来表达"这件事至少要哪个角色"。
# v0.2 第一版只挂 30 个高频写端点，覆盖 80% 风险；剩余端点继续走 ORM hook
# 默认放行（隐式 editor 等价）。
CAPABILITY_TO_ROLE: dict[str, str] = {
    # 项目级写
    "image:upload":      "editor",
    "image:delete":      "editor",
    "image:edit":        "editor",
    "task:trigger":      "editor",
    "review:decide":     "labeler",     # 审核打标横向角色也能
    "tag:edit":          "editor",
    "prompt:edit":       "project_admin",
    "strategy:edit":     "project_admin",
    "synonym:edit":      "project_admin",
    # 项目级管理
    "project:edit":      "project_admin",
    "project:delete":    "project_admin",
    "project_member:invite": "project_admin",
    "project_member:remove": "project_admin",
    # 组织级（要走 org_role 而非 project_role）
    "org:edit":          "admin",
    "org:delete":        "owner",
    "org_member:invite": "admin",
    "org_member:remove": "admin",
    "project:create":    "admin",
    "api_key:create":    "admin",
    "api_key:delete":    "admin",
    "oss_config:edit":   "admin",
}


def has_org_role(current: Optional[str], required: str) -> bool:
    """current 是当前用户在该组织的 role；required 是端点声明的最低门槛。"""
    if current is None:
        return False
    return ORG_ROLE_RANK.get(current, -1) >= ORG_ROLE_RANK.get(required, 99)


def has_project_role(current: Optional[str], required: str) -> bool:
    """同上 — 项目角色版本。labeler 跟 viewer 同级；端点要求 'labeler' 时
    labeler/viewer/editor/project_admin 都通过；要求 'editor' 时 viewer/labeler 拒。"""
    if current is None:
        return False
    if required == "labeler":
        # 横向角色：所有项目内成员都允许（含 viewer，因为审核是只读侧支线）
        return current in PROJECT_ROLE_RANK
    return PROJECT_ROLE_RANK.get(current, -1) >= PROJECT_ROLE_RANK.get(required, 99)


def require_capability(capability: str):
    """端点装饰器：声明本端点至少需要某个 capability。

    middleware 链已经把 `request.state.org_role` / `request.state.project_role`
    填好；本装饰器只做最后一脚 — 比对所需角色，403 拒绝。

    Platform owner 全程放行，不被任何 capability 拦。

    用法：
        @router.delete("/projects/{project_id}")
        @require_capability("project:delete")
        async def delete_project(...): ...
    """
    required_role = CAPABILITY_TO_ROLE.get(capability)
    if required_role is None:
        raise ValueError(f"unknown capability: {capability}")

    is_org_capability = capability.startswith(("org", "project:create", "api_key", "oss_config"))

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            request: Optional[Request] = kwargs.get("request")
            if request is None:
                # 找 args 里的 Request — FastAPI 注入的位置不固定
                for a in args:
                    if isinstance(a, Request):
                        request = a
                        break
            if request is None:
                raise RuntimeError(f"@require_capability requires Request in endpoint signature: {capability}")

            user = getattr(request.state, "user", None)
            # 平台 owner 全权
            if user is not None and getattr(user, "is_platform_owner", False):
                return await func(*args, **kwargs)
            if user is not None and getattr(user, "is_root", False):
                # 兼容 v0.1 SYSTEM_ROOT 旁路
                return await func(*args, **kwargs)

            if is_org_capability:
                role = getattr(request.state, "org_role", None)
                if not has_org_role(role, required_role):
                    raise HTTPException(403, {
                        "code": "forbidden",
                        "message": f"该操作需要组织 {required_role} 角色",
                        "capability": capability,
                        "required": required_role,
                        "current": role,
                    })
            else:
                role = getattr(request.state, "project_role", None)
                if not has_project_role(role, required_role):
                    raise HTTPException(403, {
                        "code": "forbidden",
                        "message": f"该操作需要项目 {required_role} 角色",
                        "capability": capability,
                        "required": required_role,
                        "current": role,
                    })

            return await func(*args, **kwargs)
        return wrapper
    return decorator
