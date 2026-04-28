"""add Image.cdn_path + oss_sync_jobs queue

Revision ID: 20260425_0120
Revises: 20260425_0110
Create Date: 2026-04-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260425_0120"
down_revision: Union[str, None] = "20260425_0110"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("cdn_path", sa.String(), nullable=True))

    op.create_table(
        "oss_sync_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("image_id", sa.String(), sa.ForeignKey("images.id"), nullable=False, index=True),
        sa.Column("asset_kind", sa.String(), nullable=False),
        sa.Column("object_key", sa.String(), nullable=False),
        sa.Column("local_path", sa.String(), nullable=False),
        sa.Column("content_type", sa.String(), nullable=False),
        sa.Column("status", sa.String(), default="pending", index=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text()),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("completed_at", sa.DateTime()),
    )
    op.create_index(
        "idx_oss_sync_status_created", "oss_sync_jobs", ["status", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_oss_sync_status_created", table_name="oss_sync_jobs")
    op.drop_table("oss_sync_jobs")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("cdn_path")
