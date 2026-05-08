"""drop users.email / users.password_hash / users.wechat_openid

Phase 1 决定先只用手机号登录通道，邮箱密码 + 微信扫码移除（schema 一并瘦身）。
未来需要再补时新加迁移即可。

Revision ID: 20260508_0210
Revises: 20260508_0200
Create Date: 2026-05-08 14:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260508_0210"
down_revision: Union[str, None] = "20260508_0200"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # SQLite + 已有数据：alembic batch 自动 copy-and-rename
    with op.batch_alter_table("users") as batch:
        batch.drop_index("ix_users_email")
        batch.drop_index("ix_users_wechat_openid")
        batch.drop_column("email")
        batch.drop_column("password_hash")
        batch.drop_column("wechat_openid")


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("wechat_openid", sa.String()))
        batch.add_column(sa.Column("email", sa.String()))
        batch.add_column(sa.Column("password_hash", sa.String()))
        batch.create_index("ix_users_wechat_openid", ["wechat_openid"], unique=True)
        batch.create_index("ix_users_email", ["email"], unique=True)
