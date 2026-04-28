"""add images.relative_dir for preserving source folder layout

Revision ID: 20260421_0050
Revises: 20260421_0040
Create Date: 2026-04-21 00:50:00

Also backfills relative_dir for existing rows by stripping the project's
originals_path prefix from each image's file_path. Images that can't be
attributed to a project folder (e.g. generated images) get ''.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.sql import table, column


revision: str = "20260421_0050"
down_revision: Union[str, None] = "20260421_0040"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("relative_dir", sa.String(), nullable=True, server_default=""))
    op.create_index("ix_images_relative_dir", "images", ["relative_dir"], unique=False)

    # Backfill: compute relative_dir from file_path - originals_path
    bind = op.get_bind()
    images_t = table(
        "images",
        column("id", sa.String),
        column("project_id", sa.String),
        column("file_path", sa.String),
        column("relative_dir", sa.String),
        column("source_type", sa.String),
    )
    projects_t = table(
        "projects",
        column("id", sa.String),
        column("originals_path", sa.String),
    )

    proj_rows = bind.execute(sa.select(projects_t.c.id, projects_t.c.originals_path)).fetchall()
    originals_by_project = {r.id: (r.originals_path or "").rstrip("/") for r in proj_rows}

    img_rows = bind.execute(sa.select(
        images_t.c.id, images_t.c.project_id, images_t.c.file_path, images_t.c.source_type
    )).fetchall()

    for row in img_rows:
        if row.source_type == "generated":
            continue
        base = originals_by_project.get(row.project_id, "")
        if not base or not row.file_path:
            continue
        fp = row.file_path.rstrip("/")
        if fp.startswith(base + "/"):
            # Everything between base and the filename
            rel = fp[len(base) + 1 :].rsplit("/", 1)[0] if "/" in fp[len(base) + 1 :] else ""
        else:
            rel = ""
        if rel:
            bind.execute(
                sa.update(images_t).where(images_t.c.id == row.id).values(relative_dir=rel)
            )


def downgrade() -> None:
    op.drop_index("ix_images_relative_dir", table_name="images")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("relative_dir")
