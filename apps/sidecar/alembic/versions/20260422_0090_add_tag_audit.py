"""tag_audit_logs table — primary vs audit-provider tag agreement

Revision ID: 20260422_0090
Revises: 20260422_0080
Create Date: 2026-04-22 00:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260422_0090"
down_revision: Union[str, None] = "20260422_0080"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tag_audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("image_id", sa.String(), nullable=False, index=True),
        sa.Column("primary_provider", sa.String(), nullable=False),
        sa.Column("primary_model", sa.String()),
        sa.Column("primary_tags", sa.JSON(), nullable=False),
        sa.Column("audit_provider", sa.String(), nullable=False),
        sa.Column("audit_model", sa.String()),
        sa.Column("audit_tags", sa.JSON(), nullable=False),
        sa.Column("jaccard", sa.Float(), nullable=False),         # 0..1 overall agreement
        sa.Column("per_dimension", sa.JSON()),                    # {dim: jaccard}
        sa.Column("status", sa.String(), default="ok"),           # ok | mismatch | error
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(), nullable=False, index=True),
    )
    op.create_index(
        "idx_tag_audit_provider_time",
        "tag_audit_logs",
        ["primary_provider", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_tag_audit_provider_time", table_name="tag_audit_logs")
    op.drop_table("tag_audit_logs")
