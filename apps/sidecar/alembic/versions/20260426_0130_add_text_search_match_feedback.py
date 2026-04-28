"""add Image.text_search_blob + match_feedback table

Revision ID: 20260426_0130
Revises: 20260425_0120
Create Date: 2026-04-26
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260426_0130"
down_revision: Union[str, None] = "20260425_0120"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("text_search_blob", sa.Text(), nullable=True))

    op.create_table(
        "match_feedback",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("request_id", sa.String(), index=True),
        sa.Column("api_key_id", sa.String(), index=True),
        sa.Column("text_hash", sa.String(), index=True),
        sa.Column("image_id", sa.String(), sa.ForeignKey("images.id"), index=True),
        sa.Column("rank", sa.Integer()),
        sa.Column("score", sa.Float()),
        sa.Column("was_chosen", sa.Boolean(), default=False, index=True),
        sa.Column("created_at", sa.DateTime(), index=True),
    )
    op.create_index(
        "idx_match_feedback_key_time", "match_feedback",
        ["api_key_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_match_feedback_key_time", table_name="match_feedback")
    op.drop_table("match_feedback")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("text_search_blob")
