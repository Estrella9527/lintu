"""Image 加 compressed_file_path —— 压缩派生文件路径(不再覆盖源文件)

压缩任务改为把压缩版写到 workspace/derived/compress/,路径记到此列;源文件
(file_path)永不被覆盖。OSS 同步优先上传压缩版,本地显示仍用原图。

Revision ID: 20260610_0700
Revises: 20260609_0600
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260610_0700"
down_revision: Union[str, None] = "20260609_0600"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("compressed_file_path", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.drop_column("compressed_file_path")
