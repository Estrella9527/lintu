"""图片批量压缩 engine — JPEG q=80 progressive + optimize + 4:2:0,写派生副本,**永不改源文件**。

2026-06-10 重构(用户反馈「不要把原图改成缩略图和 orig」):
  - 旧行为:原地覆盖源文件 + `.orig` 备份 —— 会动用户的原图,已废弃。
  - 新行为:压缩版写到 `workspace/derived/compress/{id[:2]}/{id}.jpg`,路径记到
    `Image.compressed_file_path`;源文件 `file_path` 一个字节都不动。
  - OSS 同步优先上传压缩版(省 CDN 流量);本地显示/导出始终用原图。

并发:
  - task 之间并发由 TaskScheduler 控制(默认 cpu_semaphore=3,可调 LINTU_CPU_CONCURRENCY)
  - task **内部**也并发 — asyncio.to_thread + Semaphore,N 默认 4(可调 LINTU_COMPRESS_PARALLEL)
  - enqueue OSS 遇到 SQLite locked 自动 retry 3 次(指数退避)

不重复压缩:派生副本已存在则跳过;force=true 时重新生成覆盖。
原图宽高/file_size_kb 不变(它们描述的是原图,原图没被动过)。
"""

import asyncio
import json
import logging
import os
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select, update

from sidecar.config import DERIVED_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.engines.image_utils import effective_file_path

logger = logging.getLogger(__name__)

# Register HEIC support if available(跟 quality_check 同款,有 HEIC 原图能读到)
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass


def _compress_derived_path(image_id: str) -> Path:
    """压缩派生副本路径:workspace/derived/compress/{id[:2]}/{id}.jpg。
    跟 orient 的 derived 布局一致(按 id 前两位分桶,避免单目录文件爆炸)。"""
    subdir = DERIVED_DIR / "compress" / (image_id[:2] or "_")
    subdir.mkdir(parents=True, exist_ok=True)
    return subdir / f"{image_id}.jpg"


def _compress_one(
    read_path: Path,
    dest_path: Path,
    *,
    quality: int = 80,
    max_long_side: int = 2400,
    force: bool = False,
) -> dict:
    """单图压缩:从 read_path(原图/旋转派生)读,压缩版写到 dest_path。
    **绝不改 read_path** —— 源文件永远保留。返回 {ok, skipped, before_kb, after_kb, error?}。

    参数:
      read_path      读取源(effective_file_path:旋转派生或原图),只读不写
      dest_path      压缩副本写到这里(workspace/derived/compress/...)
      quality        JPEG 质量(1-100),默认 80(目视无损 + 大幅减小)
      max_long_side  最长边像素上限,默认 2400;0/负 = 不缩放
      force          dest 已存在时是否重新生成覆盖
    """
    if not read_path.exists():
        return {"ok": False, "skipped": True, "error": f"file missing: {read_path}"}

    # 派生副本已存在且非 force → 跳过(本地已有压缩版)。
    if dest_path.exists() and not force:
        return {
            "ok": True, "skipped": True,
            "reason": "already_compressed (derived exists)",
            "before_kb": int(read_path.stat().st_size / 1024),
            "after_kb": int(dest_path.stat().st_size / 1024),
        }

    try:
        before_kb = int(read_path.stat().st_size / 1024)

        with PILImage.open(read_path) as img:
            # 修复 EXIF 朝向(否则缩放后照片可能侧躺)
            try:
                from PIL import ImageOps
                img = ImageOps.exif_transpose(img)
            except Exception:
                pass

            # 等比缩到 max_long_side 像素以内(若启用)
            resized = False
            orig_w, orig_h = img.size
            if max_long_side and max_long_side > 0 and max(orig_w, orig_h) > max_long_side:
                ratio = max_long_side / max(orig_w, orig_h)
                img = img.resize((int(orig_w * ratio), int(orig_h * ratio)), PILImage.Resampling.LANCZOS)
                resized = True

            # 强制转 RGB:JPEG 不支持 RGBA / P。透明背景变白。
            if img.mode in ("RGBA", "LA", "P"):
                bg = PILImage.new("RGB", img.size, (255, 255, 255))
                bg.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
                img = bg
            elif img.mode != "RGB":
                img = img.convert("RGB")

            # 先写临时文件,成功后原子改名到 dest,避免压一半留下半截文件
            tmp_path = dest_path.with_suffix(".compressing.tmp")
            try:
                img.save(
                    tmp_path, "JPEG",
                    quality=quality, optimize=True, progressive=True,
                    subsampling=2,   # 4:2:0 色度子采样
                )
            except Exception:
                tmp_path.unlink(missing_ok=True)
                raise
            new_w, new_h = img.size

        tmp_path.replace(dest_path)   # 原子落地;源文件 read_path 从未被动过

        after_kb = int(dest_path.stat().st_size / 1024)
        return {
            "ok": True, "skipped": False,
            "before_kb": before_kb, "after_kb": after_kb,
            "saved_kb": before_kb - after_kb,
            "saved_pct": round((1 - after_kb / max(1, before_kb)) * 100, 1),
            "resized": resized,
            "orig_dim": f"{orig_w}x{orig_h}",
            "new_dim": f"{new_w}x{new_h}",
            "dest": str(dest_path),
        }
    except Exception as e:
        return {"ok": False, "skipped": False, "error": str(e)[:200]}


async def run_compress(task: Task, progress_cb):
    """批量压缩 task entry。task.parameters 接收:
        image_ids       list[str]  必填,要压缩的图 id 列表
        quality         int        默认 80(1-100)
        max_long_side   int        默认 2400 像素;0 = 保持原尺寸
        force           bool       默认 False(已压过的跳过;True 用 .orig 重压)

    典型组合(参考):
      · 轻度(只压质量,保留全尺寸):  quality=88, max_long_side=0
      · 标准(覆盖 4K 显示):          quality=82, max_long_side=4000
      · 强力(覆盖手机全屏):           quality=80, max_long_side=2400  ← 默认
      · 极致(只用于 CDN 缩略):         quality=75, max_long_side=1600
    """
    params = json.loads(task.parameters or "{}")
    image_ids: list[str] = params.get("image_ids") or []
    quality: int = int(params.get("quality") or 80)
    max_long_side: int = int(params.get("max_long_side") or 2400)
    force: bool = bool(params.get("force") or False)

    if not image_ids:
        await progress_cb(total=0, processed=0)
        return

    quality = max(1, min(100, quality))

    # Task 内并发度:默认 4。Pillow 是 single-thread 但读盘+EXIF+resize+
    # JPEG 编码混合 IO,4 并发实测能跑满 4-8 核 CPU 一半,不至于把别的
    # task 饿死。可通过 env 调。
    inner_parallel = int(os.environ.get("LINTU_COMPRESS_PARALLEL") or 4)
    inner_parallel = max(1, min(16, inner_parallel))

    async def _process_one(img: Image, sem: asyncio.Semaphore) -> dict:
        """单图协程:Pillow 部分丢 to_thread,IO/db 在 event loop。"""
        async with sem:
            read_src = Path(effective_file_path(img))   # 原图 / 旋转派生,只读
            dest = _compress_derived_path(img.id)
            # Pillow 跑在 thread pool — 多个 _compress_one 真正并行
            try:
                r = await asyncio.to_thread(
                    _compress_one, read_src, dest,
                    quality=quality, max_long_side=max_long_side, force=force,
                )
            except Exception as e:
                logger.exception("compress crashed for %s", img.id)
                return {"img_id": img.id, "ok": False, "error": str(e)[:200]}
            r["img_id"] = img.id
            r["dest"] = str(dest)
            return r

    async with async_session() as db:
        result = await db.execute(select(Image).where(Image.id.in_(image_ids)))
        images = result.scalars().all()
        total = len(images)
        await progress_cb(total=total, processed=0, ok=0, skipped=0, failed=0,
                          saved_kb_total=0)

        ok_n = 0
        skipped_n = 0
        failed_n = 0
        saved_kb_total = 0
        sem = asyncio.Semaphore(inner_parallel)

        # 用 asyncio.as_completed 拿到完成顺序,可以早 commit + 早 enqueue OSS
        # 让用户能看到 OSS 队列实时滚起来,而不是憋到最后一刻全推。
        tasks_iter = [asyncio.create_task(_process_one(img, sem)) for img in images]

        # 收集压缩成功的 image_ids,task 末尾一次性 enqueue(批量,避免
        # 每张图都开新 db session 引发 SQLite locked)
        compressed_ids: list[str] = []
        idx = 0
        for coro in asyncio.as_completed(tasks_iter):
            r = await coro
            idx += 1

            if r["ok"] and not r.get("skipped"):
                ok_n += 1
                saved_kb_total += r.get("saved_kb", 0)
                # 只记压缩派生路径;原图的 file_size_kb / width / height 不动
                #(它们描述原图,而原图没被改)。
                await db.execute(
                    update(Image).where(Image.id == r["img_id"])
                    .values(compressed_file_path=r.get("dest"))
                )
                compressed_ids.append(r["img_id"])
            elif r["ok"] and r.get("skipped"):
                skipped_n += 1
                # skipped = 派生副本已存在。补记 compressed_file_path(老数据可能没记)
                # + 补一次 OSS 入队(上次可能失败 / OSS 被清空)。
                await db.execute(
                    update(Image)
                    .where(Image.id == r["img_id"], Image.compressed_file_path.is_(None))
                    .values(compressed_file_path=r.get("dest"))
                )
                compressed_ids.append(r["img_id"])
            else:
                failed_n += 1
                logger.warning("compress failed %s: %s", r.get("img_id"), r.get("error"))

            # 每 20 张 commit + 进度上报 + 批量 enqueue OSS。
            # commit 加 retry — 并发跑多个 compress task 时 SQLite 偶尔会
            # locked,死等就行(busy_timeout 已设 30s)。
            if (idx % 20 == 0 or idx == total) and compressed_ids:
                await _safe_commit(db)
                await _batch_enqueue_oss(compressed_ids)
                compressed_ids.clear()

            if idx % 5 == 0 or idx == total:
                try:
                    await progress_cb(
                        processed=idx, total=total,
                        ok=ok_n, skipped=skipped_n, failed=failed_n,
                        saved_kb_total=saved_kb_total,
                    )
                except Exception as e:
                    # progress_cb 内部也写 tasks 表,locked 时跳过不影响 task 跑
                    logger.warning("progress_cb skipped (transient): %s", str(e)[:80])

        # 末尾兜底(<20 张时 compressed_ids 还没 flush)
        if compressed_ids:
            await _safe_commit(db)
            await _batch_enqueue_oss(compressed_ids)

        await _safe_commit(db)
        logger.info(
            "compress task done: ok=%d skipped=%d failed=%d saved=%dKB (%.1fMB) parallel=%d",
            ok_n, skipped_n, failed_n, saved_kb_total, saved_kb_total / 1024, inner_parallel,
        )


async def _safe_commit(db, max_retry: int = 5) -> None:
    """commit 遇到 SQLite locked 自动 retry 指数退避。
    多 compress task 并发时 commit 会瞬间冲突,稍等再试基本就过。"""
    for attempt in range(max_retry):
        try:
            await db.commit()
            return
        except Exception as e:
            msg = str(e)
            if "database is locked" in msg and attempt < max_retry - 1:
                wait = 0.3 * (2 ** attempt)   # 0.3, 0.6, 1.2, 2.4
                logger.info("commit locked, retry in %.1fs (attempt %d)", wait, attempt + 1)
                await asyncio.sleep(wait)
                continue
            raise


async def _batch_enqueue_oss(image_ids: list[str]) -> None:
    """批量入队 OSS 同步,内部带 SQLite locked retry。
    每图调一次 enqueue_image_sync(force=True);失败的图 retry 最多 3 次。"""
    from sidecar.engines.oss_sync import enqueue_image_sync
    for iid in image_ids:
        for attempt in range(3):
            try:
                await enqueue_image_sync(iid, force=True)
                break
            except Exception as e:
                msg = str(e)
                if "database is locked" in msg and attempt < 2:
                    await asyncio.sleep(0.2 * (attempt + 1))
                    continue
                logger.warning("enqueue OSS failed for %s (attempt %d): %s",
                               iid, attempt + 1, msg[:120])
                break
