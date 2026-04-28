"""add Image.rotated_file_path — lossless orient derivative

Revision ID: 20260423_0100
Revises: 20260422_0090
Create Date: 2026-04-23
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260423_0100"
down_revision: Union[str, None] = "20260422_0090"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("rotated_file_path", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.drop_column("rotated_file_path")
