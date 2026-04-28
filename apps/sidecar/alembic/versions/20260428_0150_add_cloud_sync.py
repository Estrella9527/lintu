"""cloud_sync_jobs table — local→cloud event queue

Revision ID: 20260428_0150
Revises: 20260427_0140
Create Date: 2026-04-28 00:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260428_0150"
down_revision: Union[str, None] = "20260427_0140"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "cloud_sync_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("entity_type", sa.String(), nullable=False, index=True),  # 'image'|'project'|'api_key'|'synonyms'|'tag_schema'
        sa.Column("entity_id", sa.String(), index=True),                    # NULL for whole-dict syncs
        sa.Column("op", sa.String(), nullable=False),                       # 'upsert' | 'delete'
        sa.Column("status", sa.String(), default="pending", index=True),    # pending|running|done|failed
        sa.Column("attempts", sa.Integer(), default=0),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(), nullable=False, index=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index(
        "idx_cloud_sync_status_created",
        "cloud_sync_jobs",
        ["status", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_cloud_sync_status_created", table_name="cloud_sync_jobs")
    op.drop_table("cloud_sync_jobs")
