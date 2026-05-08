"""灵图后台管理 CLI — bootstrap-root / add-member。

用法：
    cd apps/sidecar
    uv run python -m sidecar.cli.admin bootstrap-root --phone 13800138000 --display-name "Yang"
    uv run python -m sidecar.cli.admin add-member  --phone 13800138001 --project-id <pid>

所有命令都直接对本地 sidecar 数据库（~/lintu-data/lintu.db）操作；不需要 sidecar 运行。
Phase 1 仅手机号登录通道；email/password 已删。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import secrets
import sys
from datetime import datetime
from pathlib import Path

# 让脚本能从 apps/sidecar 任意位置 import sidecar.* 的同时，避免改 sys.path
HERE = Path(__file__).resolve().parent
SIDECAR_ROOT = HERE.parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


async def cmd_bootstrap_root(args: argparse.Namespace) -> int:
    """创建第一个 root 用户 + 把它加为所有现有 project 的 member。

    保护性：已有 is_root=True 用户存在 → 直接拒绝（避免双 root 漂移）。
    """
    from sqlalchemy import select
    from sidecar.db.models import Project, ProjectMember, User
    from sidecar.db.session import async_session

    async with async_session() as db:
        existing = await db.scalar(select(User).where(User.is_root == True).limit(1))
        if existing:
            print(f"[bootstrap-root] 已有 root 用户：id={existing.id}, phone={existing.phone}", file=sys.stderr)
            print("[bootstrap-root] 拒绝重复 bootstrap。如需重置请先手 SQL UPDATE users SET is_root=0 ...", file=sys.stderr)
            return 2

        if not args.phone:
            print("[bootstrap-root] 必须提供 --phone", file=sys.stderr)
            return 1

        user = User(
            phone=args.phone,
            display_name=args.display_name or "管理员",
            is_root=True,
            status="active",
        )
        db.add(user)
        await db.flush()
        root_id = user.id

        # 把 root 加为所有现有 project 的 member（兼容现存 4500 张图）
        projects = (await db.execute(select(Project))).scalars().all()
        for p in projects:
            db.add(ProjectMember(
                project_id=p.id,
                user_id=root_id,
                role="member",       # Phase 1 全 member；root 的特权来自 is_root 标记
                invited_by=root_id,  # 自己邀请自己
            ))

        await db.commit()

    print(f"[bootstrap-root] ✓ 创建 root 用户 id={root_id}")
    print(f"[bootstrap-root] ✓ 加入 {len(projects)} 个现有项目：{', '.join(p.name for p in projects)}")
    print(f"[bootstrap-root] 手机号 {args.phone} 已绑定。下次启动 user 版应用，可用此手机号收验证码登录。")
    return 0


async def cmd_add_member(args: argparse.Namespace) -> int:
    """把现有用户加进项目。如果手机号未注册 → 先建一个空 user 再加成员。"""
    from sqlalchemy import select
    from sidecar.db.models import Project, ProjectMember, User
    from sidecar.db.session import async_session

    async with async_session() as db:
        inviter = None
        if args.invited_by:
            inviter = await db.get(User, args.invited_by)
        if inviter is None:
            inviter = await db.scalar(select(User).where(User.is_root == True).limit(1))

        user = await db.scalar(select(User).where(User.phone == args.phone))
        if user is None:
            user = User(phone=args.phone, display_name=args.display_name)
            db.add(user)
            await db.flush()
            print(f"[add-member] 用户不存在，已新建：id={user.id}")

        # 检查项目
        project = await db.get(Project, args.project_id)
        if project is None:
            print(f"[add-member] project_id={args.project_id} 不存在", file=sys.stderr)
            return 1

        # 防重复
        existing = await db.scalar(
            select(ProjectMember)
            .where(ProjectMember.project_id == args.project_id)
            .where(ProjectMember.user_id == user.id)
        )
        if existing:
            print(f"[add-member] 用户已是「{project.name}」的成员（id={existing.id}）")
            return 0

        db.add(ProjectMember(
            project_id=args.project_id,
            user_id=user.id,
            role=args.role,
            invited_by=inviter.id if inviter else None,
        ))
        await db.commit()

    print(f"[add-member] ✓ 用户 {user.id} 已加入项目「{project.name}」（role={args.role}）")
    return 0


async def cmd_reset_root(args: argparse.Namespace) -> int:
    """旧 root 失联（手机号换 / 离职）→ 把 root 标记转移到指定手机号。

    流程：
      1. 找/建 phone=args.phone 的 user
      2. 把它设 is_root=True
      3. 把所有其它 is_root=True 的 user 降级 is_root=False
      4. 把它加为所有现有 project 的 member（保证立刻能看到全部数据）

    破坏性操作：会动 is_root 字段。--yes 跳过确认。
    """
    from sqlalchemy import select
    from sidecar.db.models import Project, ProjectMember, User
    from sidecar.db.session import async_session

    if not args.yes:
        ans = input(
            f"⚠️  确认把 root 角色转移到手机号 {args.phone}？\n"
            f"    现有 root 会全部降级为普通 user（保留账号 + 项目成员关系）。\n"
            f"    [y/N]: "
        ).strip().lower()
        if ans not in ("y", "yes"):
            print("[reset-root] 已取消")
            return 1

    async with async_session() as db:
        # 1. 找/建 target user
        target = await db.scalar(select(User).where(User.phone == args.phone))
        created = False
        if target is None:
            target = User(
                phone=args.phone,
                display_name=args.display_name or "管理员",
                is_root=True,
                status="active",
            )
            db.add(target)
            await db.flush()
            created = True
            print(f"[reset-root] user 不存在，已新建：id={target.id}")

        # 2. 降级旧 root（除 target）
        old_roots = (await db.execute(
            select(User).where(User.is_root == True).where(User.id != target.id)
        )).scalars().all()
        for ru in old_roots:
            ru.is_root = False
            print(f"[reset-root] 旧 root {ru.phone} (id={ru.id[:8]}) → is_root=False")

        # 3. 升级 target
        target.is_root = True

        # 4. 加为所有 project 的 member（防重复）
        projects = (await db.execute(select(Project))).scalars().all()
        added = 0
        for p in projects:
            existing = await db.scalar(
                select(ProjectMember)
                .where(ProjectMember.project_id == p.id)
                .where(ProjectMember.user_id == target.id)
            )
            if not existing:
                db.add(ProjectMember(
                    project_id=p.id, user_id=target.id,
                    role="member", invited_by=target.id,
                ))
                added += 1

        await db.commit()

    print(f"[reset-root] ✓ {args.phone} 已设为 root（{'新建' if created else '已存在'}用户）")
    print(f"[reset-root] ✓ 降级旧 root {len(old_roots)} 个；新加 ProjectMember {added} 条")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lintu-admin", description="灵图后台管理 CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_boot = sub.add_parser("bootstrap-root", help="创建第一个 root 用户并加入全部现有项目")
    p_boot.add_argument("--phone", required=True, help="手机号（必填，唯一登录通道）")
    p_boot.add_argument("--display-name", help="昵称")
    p_boot.set_defaults(func=cmd_bootstrap_root)

    p_add = sub.add_parser("add-member", help="把用户加入项目（按 phone 查找/新建）")
    p_add.add_argument("--project-id", required=True)
    p_add.add_argument("--phone", required=True)
    p_add.add_argument("--display-name")
    p_add.add_argument("--role", default="member")
    p_add.add_argument("--invited-by")
    p_add.set_defaults(func=cmd_add_member)

    p_reset = sub.add_parser("reset-root", help="重置 root（旧 root 离职 / 手机号丢失时用）")
    p_reset.add_argument("--phone", required=True, help="新 root 手机号（必须已存在 user 或现场创建）")
    p_reset.add_argument("--display-name", help="新 root 昵称（user 不存在时用）")
    p_reset.add_argument("--yes", action="store_true", help="跳过二次确认（脚本场景用）")
    p_reset.set_defaults(func=cmd_reset_root)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    return asyncio.run(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
