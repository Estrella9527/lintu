"""add images.embedding + embedding_model for CLIP semantic dedup

Revision ID: 20260421_0070
Revises: 20260421_0060
Create Date: 2026-04-21 01:10:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260421_0070"
down_revision: Union[str, None] = "20260421_0060"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("embedding", sa.Text(), nullable=True))
        batch.add_column(sa.Column("embedding_model", sa.String(), nullable=True))
    op.create_index("ix_images_embedding_model", "images", ["embedding_model"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_images_embedding_model", table_name="images")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("embedding_model")
        batch.drop_column("embedding")
