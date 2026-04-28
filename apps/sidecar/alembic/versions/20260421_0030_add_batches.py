"""add batch_runs + batch_subtasks tables; tasks.batch_id

Revision ID: 20260421_0030
Revises: 20260421_0020
Create Date: 2026-04-21 00:30:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260421_0030"
down_revision: Union[str, None] = "20260421_0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "batch_runs",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("task_type", sa.String(), nullable=False),
        sa.Column("strategy_id", sa.String(), nullable=True),
        sa.Column("seed_image_ids", sa.JSON(), nullable=False),
        sa.Column("prompt_ids", sa.JSON(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("completed", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("failed", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("skipped", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("status", sa.String(), nullable=True, server_default="pending"),
        sa.Column("concurrency", sa.Integer(), nullable=True, server_default="10"),
        sa.Column("max_retry", sa.Integer(), nullable=True, server_default="3"),
        sa.Column("provider_chain", sa.JSON(), nullable=True),
        sa.Column("budget_usd", sa.Numeric(10, 2), nullable=True),
        sa.Column("cost_usd", sa.Numeric(10, 4), nullable=True, server_default="0"),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["strategy_id"], ["strategies.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_batch_runs_status", "batch_runs", ["status"], unique=False)

    op.create_table(
        "batch_subtasks",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("batch_id", sa.String(), nullable=False),
        sa.Column("seed_image_id", sa.String(), nullable=False),
        sa.Column("prompt_id", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=True, server_default="pending"),
        sa.Column("retry_count", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("output_image_id", sa.String(), nullable=True),
        sa.Column("cost_usd", sa.Numeric(10, 4), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["batch_id"], ["batch_runs.id"]),
        sa.ForeignKeyConstraint(["seed_image_id"], ["images.id"]),
        sa.ForeignKeyConstraint(["prompt_id"], ["prompts.id"]),
        sa.ForeignKeyConstraint(["output_image_id"], ["images.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_batch_subtasks_batch_id", "batch_subtasks", ["batch_id"], unique=False)
    op.create_index("ix_batch_subtasks_status", "batch_subtasks", ["status"], unique=False)
    op.create_index(
        "idx_batch_subtasks_batch_status",
        "batch_subtasks",
        ["batch_id", "status"],
        unique=False,
    )

    with op.batch_alter_table("tasks") as batch:
        batch.add_column(sa.Column("batch_id", sa.String(), nullable=True))
    op.create_index("ix_tasks_batch_id", "tasks", ["batch_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_tasks_batch_id", table_name="tasks")
    with op.batch_alter_table("tasks") as batch:
        batch.drop_column("batch_id")
    op.drop_index("idx_batch_subtasks_batch_status", table_name="batch_subtasks")
    op.drop_index("ix_batch_subtasks_status", table_name="batch_subtasks")
    op.drop_index("ix_batch_subtasks_batch_id", table_name="batch_subtasks")
    op.drop_table("batch_subtasks")
    op.drop_index("ix_batch_runs_status", table_name="batch_runs")
    op.drop_table("batch_runs")
