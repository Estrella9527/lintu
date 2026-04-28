"""add api_key_usage_daily — persistent per-day call counters

Revision ID: 20260425_0110
Revises: 20260423_0100
Create Date: 2026-04-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260425_0110"
down_revision: Union[str, None] = "20260423_0100"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_key_usage_daily",
        sa.Column("key_id", sa.String(), nullable=False),
        sa.Column("date", sa.String(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_estimate_usd", sa.Numeric(10, 4), server_default="0"),
        sa.Column("updated_at", sa.DateTime()),
        sa.PrimaryKeyConstraint("key_id", "date"),
    )
    op.create_index(
        "idx_api_usage_key_date",
        "api_key_usage_daily",
        ["key_id", "date"],
    )


def downgrade() -> None:
    op.drop_index("idx_api_usage_key_date", table_name="api_key_usage_daily")
    op.drop_table("api_key_usage_daily")
