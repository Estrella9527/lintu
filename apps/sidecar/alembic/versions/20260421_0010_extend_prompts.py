"""extend prompts table for first-class prompt templates

Revision ID: 20260421_0010
Revises: 20260421_0000
Create Date: 2026-04-21 00:10:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260421_0010"
down_revision: Union[str, None] = "20260421_0000"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("prompts") as batch:
        batch.add_column(sa.Column("task_type", sa.String(), nullable=True))
        batch.add_column(sa.Column("negative_prompt", sa.Text(), nullable=True))
        batch.add_column(sa.Column("variables", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("source", sa.String(), nullable=True, server_default="manual"))
        batch.add_column(sa.Column("source_doc_id", sa.String(), nullable=True))
        batch.add_column(sa.Column("tags", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("stats", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("is_active", sa.Boolean(), nullable=True, server_default=sa.true()))
        batch.add_column(sa.Column("version", sa.Integer(), nullable=True, server_default="1"))
        batch.add_column(sa.Column("parent_id", sa.String(), nullable=True))
    op.create_index("ix_prompts_task_type", "prompts", ["task_type"], unique=False)
    op.create_index("ix_prompts_is_active", "prompts", ["is_active"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_prompts_is_active", table_name="prompts")
    op.drop_index("ix_prompts_task_type", table_name="prompts")
    with op.batch_alter_table("prompts") as batch:
        batch.drop_column("parent_id")
        batch.drop_column("version")
        batch.drop_column("is_active")
        batch.drop_column("stats")
        batch.drop_column("tags")
        batch.drop_column("source_doc_id")
        batch.drop_column("source")
        batch.drop_column("variables")
        batch.drop_column("negative_prompt")
        batch.drop_column("task_type")
