"""tag 唯一约束(image_id,dimension,value)+ created_at(人工打标)

Revision ID: 20260623_0900
Revises: 20260610_0700
Create Date: 2026-06-23

人工打标会按单条增删标签,需 DB 级唯一约束防重复;created_at 供人工审标队列/审计。
先去重(同三元组保留一行,manual 优先、其次 id 最小)再加约束。
batch 模式兼容 SQLite(本地)与 PG(云端)。
"""
from alembic import op
import sqlalchemy as sa

revision = "20260623_0900"
down_revision = "20260610_0700"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    # 1. 去重:同 (image_id, dimension, value) 只保留一行(manual 优先,其次 id 最小)
    conn.execute(sa.text("""
        DELETE FROM tags WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY image_id, dimension, value
                    ORDER BY CASE WHEN source = 'manual' THEN 0 ELSE 1 END, id
                ) AS rn
                FROM tags
            ) t WHERE t.rn > 1
        )
    """))
    # 2. 加 created_at(nullable,不回填整表)+ 唯一约束
    with op.batch_alter_table("tags") as batch:
        batch.add_column(sa.Column("created_at", sa.DateTime(), nullable=True))
        batch.create_unique_constraint("uq_tag_image_dim_val", ["image_id", "dimension", "value"])


def downgrade():
    with op.batch_alter_table("tags") as batch:
        batch.drop_constraint("uq_tag_image_dim_val", type_="unique")
        batch.drop_column("created_at")
