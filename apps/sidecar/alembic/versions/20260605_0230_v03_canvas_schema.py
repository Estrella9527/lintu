"""v0.3 创作画布双模式 schema:
  - strategies 加 provenance / canvas_snapshot / style_archive_id / speed / count_per_image
  - 新增 style_archives 表(风格档案,作一致性参考用)

迁移策略:
  - 全部新字段 nullable / 有 default,兼容历史 strategies 行(provenance 默认 manual)
  - style_archives 是新表,不影响现有数据
  - 向下回滚保留所有数据 — 仅删新增列 / 表

Revision ID: 20260605_0230
Revises: 20260509_0220
Create Date: 2026-06-05 07:30:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260605_0230"
down_revision: Union[str, None] = "20260509_0220"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. 新建 style_archives(strategies 的外键依赖)
    op.create_table(
        "style_archives",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), sa.ForeignKey("projects.id"), index=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), server_default=""),
        sa.Column("ref_image_ids", sa.JSON()),
        sa.Column("strength_default", sa.Float(), server_default="0.7"),
        sa.Column("params", sa.JSON()),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )

    # 2. strategies 加 5 个字段
    # SQLite 不支持原生 ALTER COLUMN ADD with FK,所以 FK 用 batch_alter_table。
    # batch mode 要求 constraints 必须有名字,因此显式构造 ForeignKeyConstraint。
    with op.batch_alter_table("strategies") as batch:
        batch.add_column(sa.Column("provenance", sa.String(),
                                   server_default="manual"))
        batch.add_column(sa.Column("canvas_snapshot", sa.JSON()))
        batch.add_column(sa.Column("style_archive_id", sa.String()))
        batch.add_column(sa.Column("speed", sa.String(),
                                   server_default="refined"))
        batch.add_column(sa.Column("count_per_image", sa.Integer(),
                                   server_default="1"))
        batch.create_foreign_key(
            "fk_strategies_style_archive_id",
            "style_archives", ["style_archive_id"], ["id"],
        )
    op.create_index("ix_strategies_provenance", "strategies", ["provenance"])


def downgrade() -> None:
    op.drop_index("ix_strategies_provenance", table_name="strategies")
    with op.batch_alter_table("strategies") as batch:
        batch.drop_constraint("fk_strategies_style_archive_id", type_="foreignkey")
        batch.drop_column("count_per_image")
        batch.drop_column("speed")
        batch.drop_column("style_archive_id")
        batch.drop_column("canvas_snapshot")
        batch.drop_column("provenance")

    op.drop_table("style_archives")
