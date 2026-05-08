"""孤儿数据认领 — v0.1 → v0.2 升级路径。

场景：客户 v0.1.x 装机器有数据但没 user；升级 v0.2.0 后第一个登录的人自动
接管所有 default-org 数据，避免"图都看不到了"的资产损失体验。

判定条件（_claim_orphan_data_if_first_user）：
  1. default-org 存在且 active
  2. default-org 没有任何 OrganizationMember
  3. default-org 下至少有 1 个 project
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import delete, select


@pytest.fixture
async def real_auth(monkeypatch):
    monkeypatch.setenv("LINTU_AUTH_BYPASS", "0")
    yield


@pytest.fixture
async def fresh_v01_state(client, db_session):
    """模拟 v0.1 → v0.2 升级后的初始状态：
       default-org 存在 + 有 project + 没有任何成员 + 没有任何 user。"""
    from sidecar.db.models import (
        Organization, OrganizationMember, Project, ProjectMember, User,
    )

    DEFAULT_ORG = "00000000-0000-0000-0000-default-org-00"

    # 清空所有 user / 成员关系
    await db_session.execute(delete(ProjectMember))
    await db_session.execute(delete(OrganizationMember))
    # 删 sessions / sms_codes / users — 让 phone 真的是"全新"
    from sidecar.db.models import Session as US, SmsCode
    await db_session.execute(delete(US))
    await db_session.execute(delete(SmsCode))
    await db_session.execute(delete(User))

    # 确认 default-org 存在 + 有 project（如果迁移后状态是干净的，这俩应该都有）
    org = await db_session.get(Organization, DEFAULT_ORG)
    if not org:
        org = Organization(
            id=DEFAULT_ORG, name="默认组织", slug="default",
            plan="free", storage_quota_gb=100, status="active",
        )
        db_session.add(org)

    # 造一个 project（如果没有）
    pid = f"test-{uuid.uuid4().hex[:8]}"
    db_session.add(Project(
        id=pid, name="存量项目", org_id=DEFAULT_ORG,
        originals_path="/tmp/x", workspace_path="/tmp/x",
    ))
    await db_session.commit()
    return DEFAULT_ORG


async def test_first_login_claims_orphan_org(real_auth, client, db_session, fresh_v01_state):
    """第一个登录的用户自动成为 default-org owner + platform owner +
    所有 project 的 project_admin。"""
    from sidecar.db.models import OrganizationMember, ProjectMember, SmsCode, User

    DEFAULT_ORG = fresh_v01_state
    phone = "13" + "".join(str(b % 10) for b in os.urandom(9))[:9]

    # 造一条有效的 sms code（绕过 send 端点的限流）
    db_session.add(SmsCode(
        id=str(uuid.uuid4()),
        phone=phone, code="654321",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.commit()

    res = client.post("/api/auth/sms/verify", json={"phone": phone, "code": "654321"})
    assert res.status_code == 200, res.text
    body = res.json()

    # 响应里能看到认领详情
    claimed = body.get("claimed_orphan_data")
    assert claimed is not None, "首次登录应该触发认领"
    assert claimed["org_id"] == DEFAULT_ORG
    assert claimed["projects"] >= 1
    assert body.get("is_new_user") is True

    # /me payload 里应该包含至少 1 个 project（认领的）
    user_in_resp = body["user"]
    assert user_in_resp["is_platform_owner"] is True
    assert len(user_in_resp["projects"]) >= 1

    # DB 也得真的写进去
    new_user = await db_session.scalar(select(User).where(User.phone == phone))
    assert new_user is not None
    assert bool(new_user.is_platform_owner) is True
    org_mem = await db_session.scalar(
        select(OrganizationMember)
        .where(OrganizationMember.org_id == DEFAULT_ORG)
        .where(OrganizationMember.user_id == new_user.id)
    )
    assert org_mem is not None
    assert org_mem.role == "owner"
    proj_mems = (await db_session.execute(
        select(ProjectMember).where(ProjectMember.user_id == new_user.id)
    )).scalars().all()
    assert len(proj_mems) >= 1
    assert all(pm.role == "project_admin" for pm in proj_mems)


async def test_second_login_does_not_steal(real_auth, client, db_session, fresh_v01_state):
    """第一个用户认领了 default-org 后，第二个登录的人不能抢。"""
    from sidecar.db.models import OrganizationMember, SmsCode

    DEFAULT_ORG = fresh_v01_state
    p1 = "13" + "".join(str(b % 10) for b in os.urandom(9))[:9]
    p2 = "13" + "".join(str(b % 10) for b in os.urandom(9))[:9]

    # 第一个用户登录 → 认领
    db_session.add(SmsCode(
        id=str(uuid.uuid4()), phone=p1, code="111111",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.commit()
    res1 = client.post("/api/auth/sms/verify", json={"phone": p1, "code": "111111"})
    assert res1.status_code == 200
    assert res1.json().get("claimed_orphan_data") is not None

    # 第二个用户登录
    db_session.add(SmsCode(
        id=str(uuid.uuid4()), phone=p2, code="222222",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.commit()
    res2 = client.post("/api/auth/sms/verify", json={"phone": p2, "code": "222222"})
    assert res2.status_code == 200
    body2 = res2.json()
    assert body2.get("claimed_orphan_data") is None, "第二个用户不应触发认领"
    # 第二个用户不是 platform owner、没有 org member、没有 project
    assert body2["user"]["is_platform_owner"] is False
    assert body2["user"]["projects"] == []
    # DB 验证 default-org 仍只有一个成员
    mems = (await db_session.execute(
        select(OrganizationMember).where(OrganizationMember.org_id == DEFAULT_ORG)
    )).scalars().all()
    assert len(mems) == 1
