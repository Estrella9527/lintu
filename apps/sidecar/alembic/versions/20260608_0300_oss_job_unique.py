"""OSS sync job 幂等:去重历史 + 活跃态唯一索引

并发 enqueue 同一图片时,两个调用都可能看到"无活跃 job"然后各插一行,
产生重复上传任务。这里:
  1. 先把同一 (image_id, asset_kind) 的活跃行(pending/running/done)去重,
     只保留 id 最大的一行(最新),删掉旧的重复。
  2. 建部分唯一索引:同一 (image_id, asset_kind) 在 pending/running/done 三态下
     至多一行。failed/skipped 是终态,不受约束(允许重试时先删终态再插新行)。

Revision ID: 20260608_0300
Revises: 20260605_0230
"""
from __future__ import annotations

from typing import Union

from alembic import op

revision: str = "20260608_0300"
down_revision: Union[str, None] = "20260605_0230"
branch_labels = None
depends_on = None

_ACTIVE = "('pending','running','done')"
_IDX = "uq_oss_active_image_kind"


def upgrade() -> None:
    # 1. 去重:活跃态下同一 (image_id, asset_kind) 只留最新一行
    op.execute(
        f"""
        DELETE FROM oss_sync_jobs
        WHERE status IN {_ACTIVE}
          AND id NOT IN (
            SELECT MAX(id) FROM oss_sync_jobs
            WHERE status IN {_ACTIVE}
            GROUP BY image_id, asset_kind
          )
        """
    )
    # 2. 部分唯一索引(SQLite 支持 partial index)
    op.execute(
        f"""
        CREATE UNIQUE INDEX IF NOT EXISTS {_IDX}
        ON oss_sync_jobs (image_id, asset_kind)
        WHERE status IN {_ACTIVE}
        """
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {_IDX}")
