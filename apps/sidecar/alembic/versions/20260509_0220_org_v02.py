"""v0.2 组织化：organizations / organization_members 表
+ projects.org_id / api_keys.org_id / users.is_platform_owner

迁移策略：
  1. 建新表
  2. 给现有表加新列（nullable=True）
  3. 数据迁移：建 default-org → 把所有 project / api_key 的 org_id 设为 default-org →
     把所有现有 user 加为 default-org 成员（is_root user 升 owner，is_platform_owner=True）
  4. project_members.role 历史值 'member' 升级为 'editor'

向下回滚保留所有数据 — 仅删新增列 / 表，user / project / api_key 数据不会丢。

Revision ID: 20260509_0220
Revises: 20260508_0210
Create Date: 2026-05-09 09:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260509_0220"
down_revision: Union[str, None] = "20260508_0210"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 写死的 sentinel id — 让升级 / 回滚 / 测试都能找到这一行
DEFAULT_ORG_ID = "00000000-0000-0000-0000-default-org-00"
DEFAULT_ORG_SLUG = "default"


def upgrade() -> None:
    # ── 1. 建新表 ────────────────────────────────────────────────
    op.create_table(
        "organizations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False, unique=True),
        sa.Column("logo_url", sa.String()),
        sa.Column("contact_email", sa.String()),
        sa.Column("plan", sa.String(), nullable=False, server_default="free"),
        sa.Column("storage_quota_gb", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("storage_used_gb", sa.Float(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("deleted_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("ix_organizations_slug", "organizations", ["slug"], unique=True)
    op.create_index("ix_organizations_status", "organizations", ["status"])

    op.create_table(
        "organization_members",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("org_id", sa.String(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", sa.String(), nullable=False, server_default="member"),
        sa.Column("invited_by", sa.String(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("org_id", "user_id", name="uq_org_member"),
    )
    op.create_index("ix_organization_members_org_id", "organization_members", ["org_id"])
    op.create_index("ix_organization_members_user_id", "organization_members", ["user_id"])

    # ── 2. 现有表加新列（nullable=True，后面 backfill 不影响数据） ──
    with op.batch_alter_table("projects") as batch:
        batch.add_column(sa.Column("org_id", sa.String(), nullable=True))
        batch.create_index("ix_projects_org_id", ["org_id"])
        batch.create_foreign_key("fk_projects_org", "organizations", ["org_id"], ["id"])

    with op.batch_alter_table("api_keys") as batch:
        batch.add_column(sa.Column("org_id", sa.String(), nullable=True))
        batch.create_index("ix_api_keys_org_id", ["org_id"])
        batch.create_foreign_key("fk_api_keys_org", "organizations", ["org_id"], ["id"])

    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column(
            "is_platform_owner", sa.Boolean(),
            nullable=False, server_default="0",
        ))
        batch.create_index("ix_users_is_platform_owner", ["is_platform_owner"])

    # ── 3. 数据迁移 ─────────────────────────────────────────────
    conn = op.get_bind()
    import uuid
    from datetime import datetime
    now = datetime.utcnow().isoformat(sep=" ", timespec="seconds")

    # 3a. 建 default-org
    conn.execute(sa.text("""
        INSERT INTO organizations (id, name, slug, plan, storage_quota_gb, storage_used_gb, status, created_at)
        VALUES (:id, '默认组织', :slug, 'free', 100, 0, 'active', :now)
    """), {"id": DEFAULT_ORG_ID, "slug": DEFAULT_ORG_SLUG, "now": now})

    # 3b. 把所有现有 project 归到 default-org
    conn.execute(sa.text(
        "UPDATE projects SET org_id = :oid WHERE org_id IS NULL"
    ), {"oid": DEFAULT_ORG_ID})

    # 3c. 把所有现有 api_key 归到 default-org
    conn.execute(sa.text(
        "UPDATE api_keys SET org_id = :oid WHERE org_id IS NULL"
    ), {"oid": DEFAULT_ORG_ID})

    # 3d. 把所有现有 user 加为 default-org 成员
    #    is_root user → owner + is_platform_owner=True；其他 → member
    user_rows = list(conn.execute(sa.text(
        "SELECT id, is_root FROM users"
    )))
    for u_id, is_root in user_rows:
        role = "owner" if is_root else "member"
        conn.execute(sa.text("""
            INSERT INTO organization_members (id, org_id, user_id, role, invited_by, created_at)
            VALUES (:id, :oid, :uid, :role, :uid, :now)
        """), {
            "id": str(uuid.uuid4()),
            "oid": DEFAULT_ORG_ID,
            "uid": u_id,
            "role": role,
            "now": now,
        })
        if is_root:
            conn.execute(sa.text(
                "UPDATE users SET is_platform_owner = 1 WHERE id = :uid"
            ), {"uid": u_id})

    # 3e. project_members.role 历史值 'member' → 'editor'（合理的中间态）
    conn.execute(sa.text(
        "UPDATE project_members SET role = 'editor' WHERE role = 'member'"
    ))


def downgrade() -> None:
    # 删新增列；保留数据回到 v0.1.5 状态
    with op.batch_alter_table("users") as batch:
        batch.drop_index("ix_users_is_platform_owner")
        batch.drop_column("is_platform_owner")

    with op.batch_alter_table("api_keys") as batch:
        try:
            batch.drop_constraint("fk_api_keys_org", type_="foreignkey")
        except Exception:
            pass
        batch.drop_index("ix_api_keys_org_id")
        batch.drop_column("org_id")

    with op.batch_alter_table("projects") as batch:
        try:
            batch.drop_constraint("fk_projects_org", type_="foreignkey")
        except Exception:
            pass
        batch.drop_index("ix_projects_org_id")
        batch.drop_column("org_id")

    op.drop_index("ix_organization_members_user_id", table_name="organization_members")
    op.drop_index("ix_organization_members_org_id", table_name="organization_members")
    op.drop_table("organization_members")
    op.drop_index("ix_organizations_status", table_name="organizations")
    op.drop_index("ix_organizations_slug", table_name="organizations")
    op.drop_table("organizations")

    # project_members.role 'editor' 回滚为 'member'（保守 — 不动新建的 project_admin/viewer/labeler）
    op.execute("UPDATE project_members SET role = 'member' WHERE role = 'editor'")
