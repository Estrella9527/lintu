"""project.color — let users color-tag projects in the sidebar

Revision ID: 20260427_0140
Revises: 20260426_0130
Create Date: 2026-04-27 00:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260427_0140"
down_revision: Union[str, None] = "20260426_0130"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("projects") as batch:
        batch.add_column(sa.Column("color", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("projects") as batch:
        batch.drop_column("color")
