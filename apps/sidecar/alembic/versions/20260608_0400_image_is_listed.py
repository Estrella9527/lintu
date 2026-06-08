"""Image 加 is_listed(上下架)+ listed_at

匹配候选池改为 (review_status='approved') AND (is_listed=True)。
存量行回填 is_listed=True,保持现有可匹配行为不回归;OSS 反向导入的库外图
由应用层显式写 False。

Revision ID: 20260608_0400
Revises: 20260608_0300
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260608_0400"
down_revision: Union[str, None] = "20260608_0300"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("is_listed", sa.Boolean(), nullable=True))
        batch.add_column(sa.Column("listed_at", sa.DateTime(), nullable=True))
    # 存量回填 True(保持现状),再建索引。用 true(非整数 1):PG 的 boolean 列
    # 不接受整数字面量;SQLite(3.23+)也认 true,跨库安全。
    op.execute("UPDATE images SET is_listed = true WHERE is_listed IS NULL")
    op.create_index("ix_images_is_listed", "images", ["is_listed"])


def downgrade() -> None:
    op.drop_index("ix_images_is_listed", table_name="images")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("listed_at")
        batch.drop_column("is_listed")
