"""config_audit_logs — 配置变更审计

Revision ID: 20260507_0180
Revises: 20260507_0170
Create Date: 2026-05-07 14:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260507_0180"
down_revision: Union[str, None] = "20260507_0170"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "config_audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("key", sa.String(), nullable=False, index=True),
        sa.Column("old_value", sa.JSON()),
        sa.Column("new_value", sa.JSON()),
        sa.Column("source", sa.String(), nullable=False, server_default="desktop", index=True),
        sa.Column("actor_meta", sa.JSON()),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.current_timestamp(),
            index=True,
        ),
    )
    op.create_index(
        "idx_config_audit_key_time",
        "config_audit_logs",
        ["key", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_config_audit_key_time", table_name="config_audit_logs")
    op.drop_table("config_audit_logs")
