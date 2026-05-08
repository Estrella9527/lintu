"""operation_logs — 写操作审计

Revision ID: 20260508_0200
Revises: 20260508_0190
Create Date: 2026-05-08 12:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260508_0200"
down_revision: Union[str, None] = "20260508_0190"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "operation_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String()),
        sa.Column("project_id", sa.String()),
        sa.Column("method", sa.String()),
        sa.Column("path", sa.String()),
        sa.Column("status_code", sa.Integer()),
        sa.Column("summary", sa.String()),
        sa.Column("request_body_hash", sa.String()),
        sa.Column("ip", sa.String()),
        sa.Column("user_agent", sa.String()),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.current_timestamp(),
        ),
    )
    op.create_index("ix_operation_logs_user_id", "operation_logs", ["user_id"])
    op.create_index("ix_operation_logs_project_id", "operation_logs", ["project_id"])
    op.create_index("ix_operation_logs_path", "operation_logs", ["path"])
    op.create_index("ix_operation_logs_created_at", "operation_logs", ["created_at"])
    op.create_index("idx_op_log_user_time", "operation_logs", ["user_id", "created_at"])
    op.create_index("idx_op_log_path_time", "operation_logs", ["path", "created_at"])


def downgrade() -> None:
    for ix in (
        "idx_op_log_path_time", "idx_op_log_user_time",
        "ix_operation_logs_created_at", "ix_operation_logs_path",
        "ix_operation_logs_project_id", "ix_operation_logs_user_id",
    ):
        op.drop_index(ix, table_name="operation_logs")
    op.drop_table("operation_logs")
