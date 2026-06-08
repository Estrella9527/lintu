"""Image 加 in_library —— 资产库成员标记(画布草稿不默认进库)

AI 工坊生成图 / 拖到画布的本地图默认 in_library=False(只是画布草稿,不进资产库
列表、不自动推 OSS);「加入资产库」后置 True。流水线扫描 / 资产库上传 的图为 True。
存量行回填 True,保持现状不回归。

Revision ID: 20260609_0600
Revises: 20260608_0500
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260609_0600"
down_revision: Union[str, None] = "20260608_0500"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("in_library", sa.Boolean(), nullable=True))
    # 存量全部视为已在库(用 true 而非 1:PG boolean 不接受整数字面量,SQLite 也认 true)
    op.execute("UPDATE images SET in_library = true WHERE in_library IS NULL")
    op.create_index("ix_images_in_library", "images", ["in_library"])


def downgrade() -> None:
    op.drop_index("ix_images_in_library", table_name="images")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("in_library")
