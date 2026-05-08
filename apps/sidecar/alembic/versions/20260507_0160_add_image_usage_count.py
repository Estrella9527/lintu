"""images.usage_count + images.last_used_at — UGC display telemetry

Revision ID: 20260507_0160
Revises: 20260428_0150
Create Date: 2026-05-07 00:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260507_0160"
down_revision: Union[str, None] = "20260428_0150"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add columns with server_default so existing rows get 0 / NULL without a
    # backfill query. Both SQLite and PG handle ADD COLUMN with default
    # in-place, so this is fast even on the cloud's full image table.
    with op.batch_alter_table("images") as batch:
        batch.add_column(
            sa.Column("usage_count", sa.Integer(), nullable=False, server_default="0")
        )
        batch.add_column(
            sa.Column("last_used_at", sa.DateTime(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.drop_column("last_used_at")
        batch.drop_column("usage_count")
