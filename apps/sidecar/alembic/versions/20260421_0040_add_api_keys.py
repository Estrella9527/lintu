"""add api_keys + api_request_logs tables

Revision ID: 20260421_0040
Revises: 20260421_0030
Create Date: 2026-04-21 00:40:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260421_0040"
down_revision: Union[str, None] = "20260421_0030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_keys",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("key_id", sa.String(), nullable=False),
        sa.Column("key_secret_hash", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("client_type", sa.String(), nullable=True, server_default="server"),
        sa.Column("allowed_origins", sa.JSON(), nullable=True),
        sa.Column("allowed_ips", sa.JSON(), nullable=True),
        sa.Column("scopes", sa.JSON(), nullable=True),
        sa.Column("rate_limit", sa.JSON(), nullable=True),
        sa.Column("quota_used", sa.JSON(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.true()),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key_id"),
    )
    op.create_index("ix_api_keys_key_id", "api_keys", ["key_id"], unique=True)
    op.create_index("ix_api_keys_is_active", "api_keys", ["is_active"], unique=False)

    op.create_table(
        "api_request_logs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("key_id", sa.String(), nullable=True),
        sa.Column("method", sa.String(), nullable=True),
        sa.Column("path", sa.String(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("ip", sa.String(), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("request_body", sa.JSON(), nullable=True),
        sa.Column("response_size", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_api_request_logs_key_id", "api_request_logs", ["key_id"], unique=False)
    op.create_index("ix_api_request_logs_status_code", "api_request_logs", ["status_code"], unique=False)
    op.create_index("ix_api_request_logs_created_at", "api_request_logs", ["created_at"], unique=False)
    op.create_index(
        "idx_api_logs_key_time",
        "api_request_logs",
        ["key_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_api_logs_key_time", table_name="api_request_logs")
    op.drop_index("ix_api_request_logs_created_at", table_name="api_request_logs")
    op.drop_index("ix_api_request_logs_status_code", table_name="api_request_logs")
    op.drop_index("ix_api_request_logs_key_id", table_name="api_request_logs")
    op.drop_table("api_request_logs")
    op.drop_index("ix_api_keys_is_active", table_name="api_keys")
    op.drop_index("ix_api_keys_key_id", table_name="api_keys")
    op.drop_table("api_keys")
