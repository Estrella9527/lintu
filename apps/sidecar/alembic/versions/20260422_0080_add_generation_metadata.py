"""add images.generation_metadata for AI-generated provenance

Revision ID: 20260422_0080
Revises: 20260421_0070
Create Date: 2026-04-22 00:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260422_0080"
down_revision: Union[str, None] = "20260421_0070"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("generation_metadata", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.drop_column("generation_metadata")
