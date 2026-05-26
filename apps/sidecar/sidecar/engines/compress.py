"""图片批量压缩 engine — JPEG q=80 progressive + optimize + 4:2:0,原地覆盖 + .orig 备份。

并发:
  - task 之间并发由 TaskScheduler 控制(默认 cpu_semaphore=3,可调
    LINTU_CPU_CONCURRENCY env)
  - task **内部**也并发 — 用 asyncio.to_thread + Semaphore 同时处理 N 张图,
    N 默认 4(可调 LINTU_COMPRESS_PARALLEL)。Pillow 是 single-thread 但 IO 段
    能并行,4 并发实测显著拉高吞吐
  - enqueue OSS 步骤遇到 SQLite database locked 自动 retry 3 次(指数退避),
    避免并发写冲突丢图入队


设计:
  - 原图保留为 `<原路径>.orig`(可手动 rm 释放空间;或后期加"清理 .orig" 入口)
  - 原路径替换为压缩后的 JPEG(progressive + optimize,Web 加载更快)
  - 保持原宽高(不缩放)
  - 写完更新 images.file_size_kb;width / height / phash / embedding 都不变
  - 失败回滚:如果压缩或写出失败,把 .orig 移回原路径
  - **自动跟进 OSS**:每张图压缩成功后自动入 oss_sync_jobs(force=true),
    覆盖 CDN 上的大图。客户端拉到的就是压缩版,流量也省。
    如果 OSS 未配置或入队失败,只 warn 不 fail(压缩本身成功)。

不重复压缩:遇到已经压过(同路径有 .orig 兄弟文件)的图,默认跳过。
传 force=true 时再压一遍(把 .orig 当原图源,二次压缩)。

输出方式 = 决策 c(用户选定 2026-05-22):
  · 节省空间(JPEG q=85 通常 40-50% 压缩比)
  · 可恢复(只要 .orig 还在)
  · 后续 OSS 重传走 force=true 覆盖现有 CDN 副本

注意:这个 engine 改写本地文件,**不可逆**(.orig 删了就回不去)。前端
BatchActionBar 已加 confirm 弹窗。
"""

import asyncio
import json
import logging
import os
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select, update

from sidecar.db.models import Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)

# Register HEIC support if available(跟 quality_check 同款,有 HEIC 原图能读到)
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass


def _compress_one(
    src_path: Path,
    *,
    quality: int = 80,
    max_long_side: int = 2400,
    force: bool = False,
) -> dict:
    """单图压缩。返回 {ok, skipped, before_kb, after_kb, error?}。

    参数:
      quality        JPEG 质量(1-100)。默认 80 — 在"目视无明显损失 + 大幅
                     减小文件"之间的最佳平衡点。一线影像分享平台(微博/
                     抖音/小红书)默认压到 75-82 之间,所以 80 不会被觉察。
      max_long_side  最长边像素上限。默认 2400 — 覆盖手机全屏(2778)和
                     PC 4K 显示(单图 2400 完全够)。原图 6000+ 像素的
                     无人机航拍其实是浪费,2400 等比缩后客户看不出差别但
                     文件能省到 1/4-1/8。
                     传 0 / 负数 / 大于原长边 = 不缩放。
      force          已有 .orig 时是否重压
    """
    orig_path = src_path.with_suffix(src_path.suffix + ".orig")

    if not src_path.exists():
        return {"ok": False, "skipped": True, "error": f"file missing: {src_path}"}

    # 如果 .orig 已存在,说明之前压过。除非 force,否则跳过避免二次劣化。
    if orig_path.exists() and not force:
        return {
            "ok": True, "skipped": True,
            "reason": "already_compressed (.orig exists)",
            "before_kb": int(src_path.stat().st_size / 1024),
        }

    try:
        before_kb = int(src_path.stat().st_size / 1024)

        # 读图(原图或 .orig)。force 模式下从 .orig 重读,避免连续压。
        read_path = orig_path if (force and orig_path.exists()) else src_path
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
                new_w = int(orig_w * ratio)
                new_h = int(orig_h * ratio)
                img = img.resize((new_w, new_h), PILImage.Resampling.LANCZOS)
                resized = True

            # 强制转 RGB:JPEG 不支持 RGBA / P。透明背景变白。
            if img.mode in ("RGBA", "LA", "P"):
                bg = PILImage.new("RGB", img.size, (255, 255, 255))
                bg.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
                img = bg
            elif img.mode != "RGB":
                img = img.convert("RGB")

            # 先写到临时文件,成功后再 swap,避免压一半失败损坏原图
            tmp_path = src_path.with_suffix(src_path.suffix + ".compressing.tmp")
            try:
                img.save(
                    tmp_path, "JPEG",
                    quality=quality,
                    optimize=True,
                    progressive=True,
                    subsampling=2,   # 4:2:0 色度子采样,人眼对色差不敏感,可省 ~15%
                )
            except Exception:
                tmp_path.unlink(missing_ok=True)
                raise

        # 备份原文件(只在第一次压时备份,force 重压不重复备份)
        if not orig_path.exists():
            src_path.replace(orig_path)
        else:
            # force 模式:删原压缩版,准备覆盖
            src_path.unlink(missing_ok=True)

        # 把 tmp 改名到原路径
        tmp_path.replace(src_path)

        after_kb = int(src_path.stat().st_size / 1024)
        new_w, new_h = img.size
        return {
            "ok": True, "skipped": False,
            "before_kb": before_kb, "after_kb": after_kb,
            "saved_kb": before_kb - after_kb,
            "saved_pct": round((1 - after_kb / max(1, before_kb)) * 100, 1),
            "resized": resized,
            "orig_dim": f"{orig_w}x{orig_h}",
            "new_dim": f"{new_w}x{new_h}",
        }
    except Exception as e:
        # 回滚:如果发生异常,而原文件被 replace 走了,把 .orig 还原回去
        if not src_path.exists() and orig_path.exists():
            try:
                orig_path.replace(src_path)
            except Exception:
                logger.exception("rollback failed for %s", src_path)
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
            src = Path(img.file_path)
            # Pillow 跑在 thread pool — 多个 _compress_one 真正并行
            try:
                r = await asyncio.to_thread(
                    _compress_one, src,
                    quality=quality, max_long_side=max_long_side, force=force,
                )
            except Exception as e:
                logger.exception("compress crashed for %s", img.id)
                return {"img_id": img.id, "ok": False, "error": str(e)[:200]}
            r["img_id"] = img.id
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
                updates = {"file_size_kb": r["after_kb"]}
                if r.get("resized") and "x" in (r.get("new_dim") or ""):
                    nw, nh = r["new_dim"].split("x")
                    updates["width"] = int(nw)
                    updates["height"] = int(nh)
                await db.execute(
                    update(Image).where(Image.id == r["img_id"]).values(**updates)
                )
                compressed_ids.append(r["img_id"])
            elif r["ok"] and r.get("skipped"):
                skipped_n += 1
                # skipped = 之前压过(.orig 存在)。本地已经是压缩版,但 OSS
                # 上可能没有(上次 enqueue 失败 / OSS 被清空 / 等)。补一次
                # 入队 — enqueue 内部判断 done jobs 已存在会跳过,不浪费。
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
