"""add prompt_docs table

Revision ID: 20260421_0020
Revises: 20260421_0010
Create Date: 2026-04-21 00:20:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260421_0020"
down_revision: Union[str, None] = "20260421_0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "prompt_docs",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("file_path", sa.String(), nullable=False),
        sa.Column("format", sa.String(), nullable=False),
        sa.Column("parse_status", sa.String(), nullable=True, server_default="pending"),
        sa.Column("parsed_count", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("raw_content", sa.Text(), nullable=True),
        sa.Column("parsed_payload", sa.JSON(), nullable=True),
        sa.Column("parse_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_prompt_docs_parse_status", "prompt_docs", ["parse_status"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_prompt_docs_parse_status", table_name="prompt_docs")
    op.drop_table("prompt_docs")
