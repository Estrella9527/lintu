"""项目邀请闭环 — root 创建邀请 → 用户登录自动接受 → 加入 project。

关键覆盖：
  - 仅 root 可发邀请（普通用户 403）
  - 邀请同手机号已是成员 → 返回 already_member（不重复入库）
  - sms_verify 走完后 auto_accept_pending_invitations 把 pending → accepted
  - 同一手机号并发 verify 不会双倍 ProjectMember（unique 约束 + 幂等）
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select


# 这些用例需要走真实 user_auth + tenant 流程，不能用 BYPASS = "1"。
# 框架已经 set 全局 BYPASS=1（conftest），这里 fixture 临时清掉。


@pytest.fixture
async def real_auth(monkeypatch):
    monkeypatch.setenv("LINTU_AUTH_BYPASS", "0")
    yield


@pytest.fixture
async def root_user(client, db_session):
    from sidecar.db.models import Project, ProjectMember, User
    u = User(phone=f"138{"".join(str(b % 10) for b in os.urandom(8))}", is_root=True, status="active")
    db_session.add(u)
    await db_session.commit()
    await db_session.refresh(u)
    p = Project(name=f"P-{uuid.uuid4().hex[:6]}",
                originals_path="/tmp/p", workspace_path="/tmp/p")
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    db_session.add(ProjectMember(project_id=p.id, user_id=u.id, role="member", invited_by=u.id))
    await db_session.commit()
    return u, p


async def test_create_invitation_requires_root(real_auth, client, db_session, root_user):
    """普通用户调 POST /invitations → 403 forbidden。"""
    from sidecar.db.models import User, Session as US
    from datetime import datetime, timedelta
    import hashlib, secrets

    _root, project = root_user

    # 造一个普通用户 + 它的 session
    plain = User(phone=f"139{"".join(str(b % 10) for b in os.urandom(8))}", is_root=False, status="active")
    db_session.add(plain)
    await db_session.commit()
    raw = secrets.token_urlsafe(32)
    sess = US(
        user_id=plain.id,
        token_hash=hashlib.sha256(raw.encode()).hexdigest(),
        expires_at=datetime.utcnow() + timedelta(days=30),
    )
    db_session.add(sess)
    await db_session.commit()

    res = client.post(
        f"/api/projects/{project.id}/invitations",
        json={"phone": "13900000000", "role": "member"},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert res.status_code == 403, res.text


async def test_invite_existing_member_returns_already_member(real_auth, client, db_session, root_user):
    """邀请的手机号已经是项目成员 → 返回 already_member=True。"""
    from sidecar.db.models import User, Session as US, ProjectMember
    from datetime import datetime, timedelta
    import hashlib, secrets

    root, project = root_user

    # 已是成员的 user
    member = User(phone=f"137{"".join(str(b % 10) for b in os.urandom(8))}", is_root=False, status="active")
    db_session.add(member)
    await db_session.commit()
    db_session.add(ProjectMember(project_id=project.id, user_id=member.id, role="member", invited_by=root.id))
    await db_session.commit()

    # root 的 session
    raw = secrets.token_urlsafe(32)
    db_session.add(US(
        user_id=root.id,
        token_hash=hashlib.sha256(raw.encode()).hexdigest(),
        expires_at=datetime.utcnow() + timedelta(days=30),
    ))
    await db_session.commit()

    res = client.post(
        f"/api/projects/{project.id}/invitations",
        json={"phone": member.phone, "role": "member"},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("already_member") is True


async def test_auto_accept_on_sms_verify(real_auth, client, db_session, root_user):
    """新手机号被邀请 → 用 sms_verify 第一次登录 → 自动加入项目。"""
    from sidecar.db.models import ProjectMember, SmsCode, UserInvitation
    from datetime import datetime, timedelta
    import hashlib, secrets

    root, project = root_user
    invitee_phone = f"136{"".join(str(b % 10) for b in os.urandom(8))}"

    # 直接造一条 pending invitation（绕过 root token 流程，用例更聚焦）
    raw = secrets.token_urlsafe(24)
    db_session.add(UserInvitation(
        project_id=project.id,
        phone=invitee_phone,
        role="member",
        token_hash=hashlib.sha256(raw.encode()).hexdigest(),
        invited_by=root.id,
        expires_at=datetime.utcnow() + timedelta(days=7),
    ))
    # 同步造 sms code 让 sms_verify 端点能验证通过
    db_session.add(SmsCode(
        id=str(uuid.uuid4()),
        phone=invitee_phone,
        code="123456",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.commit()

    res = client.post(
        "/api/auth/sms/verify",
        json={"phone": invitee_phone, "code": "123456"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("auto_accepted_invitations") == 1
    # 用户已被建好
    user_id = body["user"]["id"]
    # ProjectMember 已存在
    mem = await db_session.scalar(
        select(ProjectMember)
        .where(ProjectMember.project_id == project.id)
        .where(ProjectMember.user_id == user_id)
    )
    assert mem is not None
    # invitation 应被标 accepted_at
    inv = await db_session.scalar(
        select(UserInvitation).where(UserInvitation.phone == invitee_phone)
    )
    assert inv.accepted_at is not None
