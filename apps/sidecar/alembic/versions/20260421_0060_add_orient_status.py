"""add images.orient_status for orientation pipeline tracking

Revision ID: 20260421_0060
Revises: 20260421_0050
Create Date: 2026-04-21 01:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260421_0060"
down_revision: Union[str, None] = "20260421_0050"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("orient_status", sa.String(), nullable=True, server_default="none"))
    op.create_index("ix_images_orient_status", "images", ["orient_status"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_images_orient_status", table_name="images")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("orient_status")
