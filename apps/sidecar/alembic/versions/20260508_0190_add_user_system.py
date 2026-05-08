"""user system Phase 1: users / sessions / project_members / sms_codes / user_invitations

Revision ID: 20260508_0190
Revises: 20260507_0180
Create Date: 2026-05-08 00:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260508_0190"
down_revision: Union[str, None] = "20260507_0180"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── users ───────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("phone", sa.String()),
        sa.Column("wechat_openid", sa.String()),
        sa.Column("email", sa.String()),
        sa.Column("password_hash", sa.String()),
        sa.Column("display_name", sa.String()),
        sa.Column("avatar_url", sa.String()),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("is_root", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("last_login_at", sa.DateTime()),
    )
    # 三 channel 都用唯一索引（NULL 允许多行，符合期望）
    op.create_index("ix_users_phone", "users", ["phone"], unique=True)
    op.create_index("ix_users_wechat_openid", "users", ["wechat_openid"], unique=True)
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_status", "users", ["status"])

    # ── sessions ────────────────────────────────────────────────────────
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("device_label", sa.String()),
        sa.Column("ip", sa.String()),
        sa.Column("user_agent", sa.String()),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.current_timestamp()),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_index("ix_sessions_token_hash", "sessions", ["token_hash"], unique=True)
    op.create_index("ix_sessions_expires_at", "sessions", ["expires_at"])
    op.create_index("idx_sessions_user_active", "sessions", ["user_id", "expires_at"])

    # ── project_members ─────────────────────────────────────────────────
    op.create_table(
        "project_members",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", sa.String(), nullable=False, server_default="member"),
        sa.Column("invited_by", sa.String(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.current_timestamp()),
        sa.UniqueConstraint("project_id", "user_id", name="uq_project_member"),
    )
    op.create_index("ix_project_members_project_id", "project_members", ["project_id"])
    op.create_index("ix_project_members_user_id", "project_members", ["user_id"])

    # ── sms_codes ───────────────────────────────────────────────────────
    op.create_table(
        "sms_codes",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("phone", sa.String(), nullable=False),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.current_timestamp()),
    )
    op.create_index("ix_sms_codes_phone", "sms_codes", ["phone"])
    op.create_index("ix_sms_codes_expires_at", "sms_codes", ["expires_at"])
    op.create_index("ix_sms_codes_created_at", "sms_codes", ["created_at"])
    op.create_index("idx_sms_codes_phone_time", "sms_codes", ["phone", "created_at"])

    # ── user_invitations ────────────────────────────────────────────────
    op.create_table(
        "user_invitations",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("phone", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False, server_default="member"),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("invited_by", sa.String(), sa.ForeignKey("users.id")),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("accepted_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.current_timestamp()),
    )
    op.create_index("ix_user_invitations_project_id", "user_invitations", ["project_id"])
    op.create_index("ix_user_invitations_phone", "user_invitations", ["phone"])
    op.create_index("ix_user_invitations_token_hash", "user_invitations", ["token_hash"], unique=True)
    op.create_index("ix_user_invitations_expires_at", "user_invitations", ["expires_at"])
    op.create_index("idx_invitations_project_phone", "user_invitations", ["project_id", "phone"])


def downgrade() -> None:
    op.drop_table("user_invitations")
    op.drop_table("sms_codes")
    op.drop_table("project_members")
    op.drop_table("sessions")
    op.drop_table("users")
