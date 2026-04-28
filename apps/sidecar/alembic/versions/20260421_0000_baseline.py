"""baseline

Revision ID: 20260421_0000
Revises:
Create Date: 2026-04-21 00:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260421_0000"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("originals_path", sa.String(), nullable=False),
        sa.Column("workspace_path", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "images",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("file_path", sa.String(), nullable=False),
        sa.Column("file_name", sa.String(), nullable=False),
        sa.Column("file_hash", sa.String(), nullable=True),
        sa.Column("phash", sa.String(), nullable=True),
        sa.Column("file_size_kb", sa.Integer(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("blur_score", sa.Float(), nullable=True),
        sa.Column("brightness", sa.Float(), nullable=True),
        sa.Column("quality_status", sa.String(), nullable=True),
        sa.Column("reject_reason", sa.String(), nullable=True),
        sa.Column("dedup_group_id", sa.String(), nullable=True),
        sa.Column("is_kept", sa.Boolean(), nullable=True),
        sa.Column("tag_status", sa.String(), nullable=True),
        sa.Column("tagged_at", sa.DateTime(), nullable=True),
        sa.Column("tag_provider", sa.String(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("source_type", sa.String(), nullable=True),
        sa.Column("parent_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["images.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_images_file_hash", "images", ["file_hash"], unique=False)
    op.create_index("ix_images_phash", "images", ["phash"], unique=False)
    op.create_index("ix_images_quality_status", "images", ["quality_status"], unique=False)
    op.create_index("ix_images_dedup_group_id", "images", ["dedup_group_id"], unique=False)
    op.create_index("ix_images_tag_status", "images", ["tag_status"], unique=False)
    op.create_index(
        "idx_images_project_status",
        "images",
        ["project_id", "quality_status", "tag_status"],
        unique=False,
    )

    op.create_table(
        "tags",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("image_id", sa.String(), nullable=False),
        sa.Column("dimension", sa.String(), nullable=False),
        sa.Column("value", sa.String(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("source", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["image_id"], ["images.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tags_dimension", "tags", ["dimension"], unique=False)
    op.create_index("ix_tags_value", "tags", ["value"], unique=False)
    op.create_index("idx_tag_dim_val", "tags", ["dimension", "value"], unique=False)

    op.create_table(
        "tasks",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("parameters", sa.Text(), nullable=True),
        sa.Column("total", sa.Integer(), nullable=True),
        sa.Column("processed", sa.Integer(), nullable=True),
        sa.Column("failed", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Float(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tasks_status", "tasks", ["status"], unique=False)

    op.create_table(
        "prompts",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("category", sa.String(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_prompts_category", "prompts", ["category"], unique=False)

    op.create_table(
        "strategies",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("icon_keyword", sa.String(), nullable=True),
        sa.Column("task_type", sa.String(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=True),
        sa.Column("parameters", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=True),
        sa.Column("is_builtin", sa.Boolean(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "duplicate_groups",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("kept_image_id", sa.String(), nullable=True),
        sa.Column("image_count", sa.Integer(), nullable=True),
        sa.Column("avg_hamming_distance", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["kept_image_id"], ["images.id"]),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("duplicate_groups")
    op.drop_table("strategies")
    op.drop_index("ix_prompts_category", table_name="prompts")
    op.drop_table("prompts")
    op.drop_index("ix_tasks_status", table_name="tasks")
    op.drop_table("tasks")
    op.drop_index("idx_tag_dim_val", table_name="tags")
    op.drop_index("ix_tags_value", table_name="tags")
    op.drop_index("ix_tags_dimension", table_name="tags")
    op.drop_table("tags")
    op.drop_index("idx_images_project_status", table_name="images")
    op.drop_index("ix_images_tag_status", table_name="images")
    op.drop_index("ix_images_dedup_group_id", table_name="images")
    op.drop_index("ix_images_quality_status", table_name="images")
    op.drop_index("ix_images_phash", table_name="images")
    op.drop_index("ix_images_file_hash", table_name="images")
    op.drop_table("images")
    op.drop_table("projects")
