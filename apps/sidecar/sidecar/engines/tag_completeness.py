"""打标完整度判定(用于检索质量提示与人工治理报表)。

单一真相来源:标签体系(tag_schema)里 required=True 的维度即"必填维度"。
一张图必须在每个必填维度上至少有一个标签,才算"已打标"。
当前版本中标签不再阻塞「上传到图库」或 OSS 同步；本模块仍供审核历史、
质量提示和后续检索治理复用。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Tag


def required_dimensions() -> list[str]:
    """当前标签体系里 required=True 的维度键。schema 读失败则返回空(不拦)。"""
    try:
        from sidecar.routers.tag_schema import _read_schema
        return [d for d, c in _read_schema().items() if c.get("required")]
    except Exception:
        return []


async def missing_required_dims(db: AsyncSession, image_id: str) -> list[str]:
    """返回该图**缺**的必填维度;空列表 = 必填维度都打全了。"""
    required = required_dimensions()
    if not required:
        return []
    present = {
        r[0] for r in (await db.execute(
            select(Tag.dimension).where(Tag.image_id == image_id)
            .where(Tag.dimension.in_(required))
        )).all()
    }
    return [d for d in required if d not in present]


async def is_fully_tagged(db: AsyncSession, image_id: str) -> bool:
    return not await missing_required_dims(db, image_id)
