"""来源追溯 + 上传批次:images 加追溯字段 + upload_batches 表

治理策略第一期:把"谁传的、哪个来源渠道、哪一批、谁审的"落到数据层。
- images 增:uploaded_by / source_channel / upload_batch_id / reviewed_by
  (审核入库时间复用已有 reviewed_at,不再另开 approved_at)
- 新增 upload_batches:批次号/项目/来源渠道/上传人/关联任务/备注/张数计数
存量行这些字段留空(nullable),不回填、不回归。

Revision ID: 20260711_0900
Revises: 20260623_0900
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260711_0900"
down_revision: Union[str, None] = "20260623_0900"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) 上传批次表
    op.create_table(
        "upload_batches",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("batch_no", sa.String(), nullable=False),      # 日期+序号,如 20260711-001
        sa.Column("source_channel", sa.String(), nullable=False),  # AI生产/摄影补拍/UGC投稿/OTA授权
        sa.Column("uploaded_by", sa.String()),                   # 上传人(user id)
        sa.Column("uploaded_by_name", sa.String()),              # 上传人显示名(冗余,免联表)
        sa.Column("task_id", sa.String()),                       # 关联生产任务(可选)
        sa.Column("note", sa.Text()),                            # 批次备注
        sa.Column("total", sa.Integer(), server_default="0"),    # 本批张数
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )
    op.create_index("ix_upload_batches_project", "upload_batches", ["project_id"])

    # 2) images 追溯字段
    with op.batch_alter_table("images") as batch:
        batch.add_column(sa.Column("uploaded_by", sa.String()))
        batch.add_column(sa.Column("source_channel", sa.String()))
        batch.add_column(sa.Column("upload_batch_id", sa.String()))
        batch.add_column(sa.Column("reviewed_by", sa.String()))
    op.create_index("ix_images_upload_batch_id", "images", ["upload_batch_id"])
    op.create_index("ix_images_source_channel", "images", ["source_channel"])


def downgrade() -> None:
    op.drop_index("ix_images_source_channel", table_name="images")
    op.drop_index("ix_images_upload_batch_id", table_name="images")
    with op.batch_alter_table("images") as batch:
        batch.drop_column("reviewed_by")
        batch.drop_column("upload_batch_id")
        batch.drop_column("source_channel")
        batch.drop_column("uploaded_by")
    op.drop_index("ix_upload_batches_project", table_name="upload_batches")
    op.drop_table("upload_batches")
