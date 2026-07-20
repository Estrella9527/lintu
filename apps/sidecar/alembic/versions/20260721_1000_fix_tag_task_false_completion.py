"""修正历史打标任务的假完成状态。

v0.3.4 及之前的打标引擎会吞掉逐图失败：任务仍被调度器标成 completed，
同时 failed 始终为 0。对 total > processed 的历史打标任务，缺口就是已经
尝试但未成功的图片数；升级时改为 failed，避免用户继续看到“0/64 已完成”。

Revision ID: 20260721_1000
Revises: 20260711_0900
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260721_1000"
down_revision: Union[str, None] = "20260711_0900"
branch_labels = None
depends_on = None


_MIGRATION_ERROR = "历史任务状态已修正：旧版本吞掉了逐图打标失败，请重试任务"


def upgrade() -> None:
    op.execute(sa.text("""
        UPDATE tasks
        SET status = 'failed',
            failed = total - processed,
            error_message = :message
        WHERE type = 'tag'
          AND status = 'completed'
          AND total > processed
    """).bindparams(message=_MIGRATION_ERROR))


def downgrade() -> None:
    op.execute(sa.text("""
        UPDATE tasks
        SET status = 'completed',
            failed = 0,
            error_message = NULL
        WHERE type = 'tag'
          AND status = 'failed'
          AND error_message = :message
    """).bindparams(message=_MIGRATION_ERROR))
