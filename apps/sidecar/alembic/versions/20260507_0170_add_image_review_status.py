"""images.review_status + reviewed_at — pre-publish review queue

Revision ID: 20260507_0170
Revises: 20260507_0160
Create Date: 2026-05-07 12:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260507_0170"
down_revision: Union[str, None] = "20260507_0160"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # `approved` default keeps existing rows visible in matching — only
    # newly AI-generated images will be created with `pending` (set in
    # the batch_engine, not here).
    with op.batch_alter_table("images") as batch:
        batch.add_column(
            sa.Column(
                "review_status",
                sa.String(),
                nullable=False,
                server_default="approved",
            )
        )
        batch.add_column(
            sa.Column("reviewed_at", sa.DateTime(), nullable=True)
        )
    # Index for the common "list pending" query — the review queue page.
    op.create_index(
        "idx_images_review_status",
        "images",
        ["project_id", "review_status"],
    )


def downgrade() -> None:
    op.drop_index("idx_images_review_status", table_name="images")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("reviewed_at")
        batch.drop_column("review_status")
