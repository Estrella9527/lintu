"""一次性自愈:把旧压缩任务的 `.orig` 备份还原回原图。

背景:v0.3.0 及之前的压缩任务原地覆盖源文件(压缩版写回原路径,原图改名
`<path>.orig`)。v0.3.1 起压缩只写派生副本、不动源文件;此模块在 sidecar
启动时把历史 `.orig` 自动还原 —— 用户(含运营同事的机器)升级后无感恢复原图。

幂等:按 DB 遍历每图一次 `stat`,没有 `.orig` 时近零开销;还原后顺带修正
DB 里被旧压缩改过的 file_size_kb / width / height。
"""
import asyncio
import logging
import os
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select, update

from sidecar.db.models import Image
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)


async def restore_orig_backups() -> int:
    """还原所有 `<file_path>.orig` → `<file_path>`。返回还原张数。"""

    def _scan_and_restore(rows: list[tuple[str, str]]) -> list[tuple[str, str]]:
        """线程里跑文件 IO:返回 [(image_id, file_path)] 已还原列表。"""
        restored: list[tuple[str, str]] = []
        for img_id, fp in rows:
            orig = Path(fp + ".orig")
            if not orig.exists():
                continue
            try:
                os.replace(orig, fp)   # 原子:原图盖回压缩版
                restored.append((img_id, fp))
            except OSError as e:
                logger.warning("restore .orig failed for %s: %s", fp, e)
        return restored

    async with async_session() as db:
        rows = (await db.execute(select(Image.id, Image.file_path))).all()
        restored = await asyncio.to_thread(
            _scan_and_restore, [(r[0], r[1]) for r in rows]
        )
        if not restored:
            return 0

        # 原图回来了 → 修正 DB 里被旧压缩改写过的尺寸/大小
        for img_id, fp in restored:
            try:
                p = Path(fp)
                size_kb = int(p.stat().st_size / 1024)
                with PILImage.open(p) as im:
                    w, h = im.size
                await db.execute(
                    update(Image).where(Image.id == img_id)
                    .values(file_size_kb=size_kb, width=w, height=h)
                )
            except Exception as e:
                logger.warning("dim recompute failed for %s: %s", img_id, e)
        await db.commit()

    logger.info("restored %d originals from .orig backups", len(restored))
    return len(restored)
