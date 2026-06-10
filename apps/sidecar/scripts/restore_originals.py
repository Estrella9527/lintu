"""一次性还原:把旧压缩任务备份的 `<path>.orig` 改回原文件,恢复原图。

背景:旧版 compress.py 原地覆盖源文件(压缩版写回原路径,原图存为 `.orig`)。
用户反馈「不要把原图改成缩略图和 orig」。新版已改为写派生副本不动源;此脚本把
已经被覆盖的原图从 `.orig` 还原回来,并修正 DB 里被改过的 file_size_kb/width/height。

幂等:跑完没有 `.orig` 剩下;再跑一次就是 no-op。

用法:
    cd apps/sidecar && uv run python -m scripts.restore_originals          # 实际还原
    cd apps/sidecar && uv run python -m scripts.restore_originals --dry    # 只看不动
"""
import asyncio
import os
import sys
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select, update

from sidecar.config import DATA_DIR
from sidecar.db.models import Image
from sidecar.db.session import async_session

DRY = "--dry" in sys.argv


def _restore_file(orig: Path) -> bool:
    """把 orig(<path>.orig)改回 <path>,覆盖压缩版。成功返回 True。"""
    target = orig.with_suffix("")  # photo.jpg.orig → photo.jpg
    if DRY:
        print(f"  [dry] {orig}  ->  {target}")
        return True
    try:
        os.replace(orig, target)   # 原子:原图盖回压缩版
        return True
    except OSError as e:
        print(f"  ! restore failed {orig}: {e}")
        return False


async def main() -> None:
    restored = 0
    db_fixed = 0
    async with async_session() as db:
        imgs = (await db.execute(select(Image))).scalars().all()
        for img in imgs:
            orig = Path(str(img.file_path) + ".orig")
            if not orig.exists():
                continue
            if not _restore_file(orig):
                continue
            restored += 1
            if DRY:
                continue
            # 原图回来了,修正 DB 里被旧压缩改过的尺寸/大小
            target = Path(img.file_path)
            try:
                size_kb = int(target.stat().st_size / 1024)
                with PILImage.open(target) as im:
                    w, h = im.size
                await db.execute(
                    update(Image).where(Image.id == img.id)
                    .values(file_size_kb=size_kb, width=w, height=h)
                )
                db_fixed += 1
            except Exception as e:
                print(f"  ! dim recompute failed {img.id}: {e}")
        if not DRY:
            await db.commit()

    # 文件系统兜底:DB 里没有对应行的孤儿 .orig(图已删但备份还在)也还原掉
    orphan = 0
    for orig in DATA_DIR.rglob("*.orig"):
        if _restore_file(orig):
            orphan += 1

    print("─" * 50)
    print(f"还原原图: {restored} 张(DB 关联){' + ' + str(orphan) + ' 个孤儿' if orphan else ''}")
    print(f"修正 DB 尺寸/大小: {db_fixed} 行")
    if DRY:
        print("(--dry 模式,未实际改动)")


if __name__ == "__main__":
    asyncio.run(main())
