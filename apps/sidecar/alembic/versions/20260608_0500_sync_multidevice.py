"""多设备同步(方案A 云端权威)基建:墓碑表 + 同步表补 updated_at

- 新建 sync_tombstones(entity_type, entity_id, deleted_at):删除事件载体,
  供 GET /internal/sync/changes 增量 feed 读出 since 之后的删除。
- 给同步表补 updated_at(增量游标 + LWW 仲裁键):projects / organizations /
  organization_members / users / project_members。images / api_keys 已有。
- 存量行 updated_at 回填为 created_at(没有则当前时间),不丢历史。
- 建 updated_at 索引(含 images.updated_at,原本只有列没索引),供 feed 范围扫。

SQLite(本地) 与 PG(云端) 双兼容。

Revision ID: 20260608_0500
Revises: 20260608_0400
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260608_0500"
down_revision: Union[str, None] = "20260608_0400"
branch_labels = None
depends_on = None


# 需要补 updated_at 的表(images / api_keys 已有,只补索引)
_ADD_UPDATED_AT = ["projects", "organizations", "organization_members", "users", "project_members"]
_INDEX_ONLY = ["images", "api_keys"]


def upgrade() -> None:
    # 1. 墓碑表
    op.create_table(
        "sync_tombstones",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("entity_type", sa.String(), nullable=False),
        sa.Column("entity_id", sa.String(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("entity_type", "entity_id", name="uq_tombstone_entity"),
    )
    op.create_index("ix_sync_tombstones_entity_type", "sync_tombstones", ["entity_type"])
    op.create_index("ix_sync_tombstones_entity_id", "sync_tombstones", ["entity_id"])
    op.create_index("ix_sync_tombstones_deleted_at", "sync_tombstones", ["deleted_at"])

    # 2. 补 updated_at 列 + 回填 + 建索引
    for tbl in _ADD_UPDATED_AT:
        with op.batch_alter_table(tbl) as batch:
            batch.add_column(sa.Column("updated_at", sa.DateTime(), nullable=True))
        # 回填:优先用 created_at,缺失则当前时间
        op.execute(
            f"UPDATE {tbl} SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) "
            f"WHERE updated_at IS NULL"
        )
        op.create_index(f"ix_{tbl}_updated_at", tbl, ["updated_at"])

    # 3. 已有 updated_at 的表只补索引(供 feed)
    for tbl in _INDEX_ONLY:
        op.create_index(f"ix_{tbl}_updated_at", tbl, ["updated_at"])


def downgrade() -> None:
    for tbl in _INDEX_ONLY:
        op.drop_index(f"ix_{tbl}_updated_at", table_name=tbl)
    for tbl in _ADD_UPDATED_AT:
        op.drop_index(f"ix_{tbl}_updated_at", table_name=tbl)
        with op.batch_alter_table(tbl) as batch:
            batch.drop_column("updated_at")
    op.drop_index("ix_sync_tombstones_deleted_at", table_name="sync_tombstones")
    op.drop_index("ix_sync_tombstones_entity_id", table_name="sync_tombstones")
    op.drop_index("ix_sync_tombstones_entity_type", table_name="sync_tombstones")
    op.drop_table("sync_tombstones")
