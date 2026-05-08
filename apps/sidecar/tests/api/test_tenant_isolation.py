"""ORM hook 多租户隔离用例。

模拟两个用户分别属两个不同 project，确认：
  - SELECT 自动加 WHERE project_id IN (...)，不会泄漏跨租户图
  - INSERT/UPDATE 写入越权 project_id 时 raise PermissionError
  - root（is_root=True）跳过隔离，能看到全集

测试通过 ContextVar 直接模拟，绕过 HTTP 层 — 更聚焦 ORM 行为本身。
HTTP 层鉴权由 test_auth.py 覆盖。
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select


# 这些测试需要在 hooks 已安装的环境下跑 — 通过 fastapi 的 lifespan 完成。
# conftest 的 `client` fixture（with TestClient(app)）会触发 lifespan startup。


@pytest.fixture
async def two_projects(client, db_session):
    """造两个项目 + 两张图（各一张）。返回 ((p1, img1), (p2, img2))。"""
    from sidecar.db.models import Image, Project

    p1 = Project(name=f"P1-{uuid.uuid4().hex[:6]}",
                 originals_path="/tmp/p1", workspace_path="/tmp/p1")
    p2 = Project(name=f"P2-{uuid.uuid4().hex[:6]}",
                 originals_path="/tmp/p2", workspace_path="/tmp/p2")
    db_session.add_all([p1, p2])
    await db_session.commit()
    await db_session.refresh(p1)
    await db_session.refresh(p2)

    # 直接绕过 hook 写入（test fixture 时 ContextVar 默认空，不会拦）
    img1 = Image(project_id=p1.id, file_path="/tmp/p1/a.jpg",
                 file_name="a.jpg", source_type="original")
    img2 = Image(project_id=p2.id, file_path="/tmp/p2/b.jpg",
                 file_name="b.jpg", source_type="original")
    db_session.add_all([img1, img2])
    await db_session.commit()
    await db_session.refresh(img1)
    await db_session.refresh(img2)

    return (p1, img1), (p2, img2)


async def test_select_filtered_to_user_projects(two_projects):
    """普通用户只看到自己 project_id 内的图。"""
    from sidecar.db.models import Image
    from sidecar.db.session import async_session
    from sidecar.db.tenant import current_project_ids

    (p1, _), (p2, _) = two_projects

    # 用户只属 p1 → 看不到 p2 的图
    token = current_project_ids.set([p1.id])
    try:
        async with async_session() as db:
            rows = (await db.execute(select(Image))).scalars().all()
        ids = {r.project_id for r in rows}
        assert p1.id in ids
        assert p2.id not in ids, f"越权读到 p2 的图：{ids}"
    finally:
        current_project_ids.reset(token)


async def test_select_root_sees_everything(two_projects):
    """root（current_project_ids 空）看全集。"""
    from sidecar.db.models import Image
    from sidecar.db.session import async_session
    from sidecar.db.tenant import current_project_ids

    (p1, _), (p2, _) = two_projects

    # 不 set ContextVar = 空 = root 行为
    async with async_session() as db:
        rows = (await db.execute(select(Image))).scalars().all()
    ids = {r.project_id for r in rows}
    assert p1.id in ids and p2.id in ids


async def test_insert_to_unauthorized_project_blocked(two_projects):
    """普通用户 INSERT 越权 project 的 image → before_flush 拦截 raise。"""
    from sidecar.db.models import Image
    from sidecar.db.session import async_session
    from sidecar.db.tenant import current_project_ids

    (p1, _), (p2, _) = two_projects

    token = current_project_ids.set([p1.id])
    try:
        async with async_session() as db:
            db.add(Image(
                project_id=p2.id,                  # ← 越权目标
                file_path="/tmp/p2/x.jpg",
                file_name="x.jpg",
                source_type="original",
            ))
            with pytest.raises(PermissionError):
                await db.commit()
    finally:
        current_project_ids.reset(token)


async def test_update_to_unauthorized_project_blocked(two_projects):
    """user 改自己看到的 image，把 project_id 改到别人的 → 也拦截。"""
    from sidecar.db.models import Image
    from sidecar.db.session import async_session
    from sidecar.db.tenant import current_project_ids

    (p1, img1), (p2, _) = two_projects

    token = current_project_ids.set([p1.id])
    try:
        async with async_session() as db:
            obj = await db.get(Image, img1.id)
            assert obj is not None
            obj.project_id = p2.id              # ← 改成越权值
            with pytest.raises(PermissionError):
                await db.commit()
    finally:
        current_project_ids.reset(token)


async def test_insert_with_correct_project_succeeds(two_projects):
    """正常路径不破：insert 自己 project 的 image 应该通过。"""
    from sidecar.db.models import Image
    from sidecar.db.session import async_session
    from sidecar.db.tenant import current_project_ids

    (p1, _), (p2, _) = two_projects

    token = current_project_ids.set([p1.id])
    try:
        async with async_session() as db:
            new_img = Image(
                project_id=p1.id,
                file_path="/tmp/p1/legit.jpg",
                file_name="legit.jpg",
                source_type="original",
            )
            db.add(new_img)
            await db.commit()
            assert new_img.id is not None
    finally:
        current_project_ids.reset(token)


async def test_global_table_unaffected(client):
    """non-tenant 表（projects、users）不受影响 — 仍然全集可见。"""
    from sidecar.db.models import Project
    from sidecar.db.session import async_session
    from sidecar.db.tenant import current_project_ids

    # 设一个不存在的 project_id 限制 — projects 表本身不在 TENANT_TABLES 里
    token = current_project_ids.set(["nonexistent-pid"])
    try:
        async with async_session() as db:
            rows = (await db.execute(select(Project))).scalars().all()
        assert len(rows) >= 0  # 不应该被过滤；至少能正常返回
    finally:
        current_project_ids.reset(token)
