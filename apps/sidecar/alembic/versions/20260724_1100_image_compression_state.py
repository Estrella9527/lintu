"""Track automatic upload compression state on images.

New asset-library uploads keep the pristine local original, generate a
private compressed derivative, and only become eligible for OSS publication
after that derivative is ready. Historical rows stay NULL for compatibility.

Revision ID: 20260724_1100
Revises: 20260721_1000
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260724_1100"
down_revision: Union[str, None] = "20260721_1000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("compression_status", sa.String(), nullable=True))
        batch.add_column(sa.Column("compression_error", sa.Text(), nullable=True))
        batch.add_column(sa.Column("compression_profile", sa.String(), nullable=True))
        batch.add_column(sa.Column("compressed_size_kb", sa.Integer(), nullable=True))
        batch.create_index("ix_images_compression_status", ["compression_status"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.drop_index("ix_images_compression_status")
        batch.drop_column("compressed_size_kb")
        batch.drop_column("compression_profile")
        batch.drop_column("compression_error")
        batch.drop_column("compression_status")
