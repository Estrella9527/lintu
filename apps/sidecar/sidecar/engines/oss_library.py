"""OSS 反向导入 —— 让「OSS bucket 里的图」成为「灵图库的图」。

UGC 需求(2026-06):OSS bucket 里有外部直传的图,灵图库里没有对应记录。
这些图应当自动进入灵图库(默认待审核、未上架),运营审核+上架后参与 UGC 匹配。

本模块提供:
  - scan_bucket()  : 列出 bucket 全部原图对象,标注每个对象「是否已入库 / 审核态 / 上架态」
  - import_orphans(): 把库外对象下载到本地、建 Image 行(pending + 未上架,cdn_path=对象 key),
                      并派发 embed + tag 任务,使其在审核+上架后能真正被匹配召回。

对象命名约定(见 oss_sync.object_key_for):
  - 原图    : i/{image_id}.{ext}
  - 缩略图  : i/{image_id}_300.jpg / i/{image_id}_800.jpg  ← 扫描时跳过
外部直传的对象通常不遵守 i/{我方id} 命名 —— 这类一律视为库外对象,导入时生成新
image_id,cdn_path 指向其原始 key(不改名、不搬动 bucket 里的对象)。
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.engines.oss_sync import get_storage

logger = logging.getLogger(__name__)

# bucket 里原图前缀(缩略图也在 i/ 下,靠后缀区分)
_IMG_PREFIX = "i/"
_THUMB_RE = re.compile(r"_(300|800)\.jpg$", re.IGNORECASE)
# i/{id}.{ext} 形态:我方同步上去的原图
_OWNED_RE = re.compile(r"^i/([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$")

_IMPORT_DIR = WORKSPACE_DIR / "oss_import"


def _is_thumb(key: str) -> bool:
    return bool(_THUMB_RE.search(key))


def _owned_image_id(key: str) -> str | None:
    """若 key 是我方命名 i/{id}.{ext},返回 id;否则 None(库外对象)。"""
    m = _OWNED_RE.match(key)
    return m.group(1) if m else None


_PREVIEW_CAP = 500  # items 明细 + preview_url 上限,避免一次回传/签名上千条


async def scan_bucket(preview: bool = True) -> dict:
    """扫描 bucket,返回每个原图对象的入库/审核/上架状态。

    返回:
      {
        "configured": bool,
        "total_objects": int,          # 原图对象数(不含缩略图)
        "in_library": int,             # 已入库
        "orphans": int,                # 库外(可导入)
        "items": [ { object_key, in_library, image_id?, review_status?,
                     is_listed?, source_type?, preview_url? } ]  # 最多 _PREVIEW_CAP 条
      }
    """
    storage = get_storage()
    if not storage.is_read_configured():
        return {"configured": False, "total_objects": 0, "in_library": 0, "orphans": 0, "items": []}

    keys = [k for k in storage.list_keys(_IMG_PREFIX) if not _is_thumb(k)]

    # 一次性把 cdn_path 已落库的对象捞出来做匹配(cdn_path == object_key)
    async with async_session() as db:
        rows = await db.execute(
            select(Image.id, Image.cdn_path, Image.review_status, Image.is_listed,
                   Image.source_type)
        )
        by_cdn: dict[str, tuple] = {}
        owned_ids: set[str] = set()
        for iid, cdn, rev, listed, src in rows.all():
            owned_ids.add(iid)
            if cdn:
                by_cdn[cdn] = (iid, rev, listed, src)

    # 先算全量入库数(不受 items 截断影响),再只把前 _PREVIEW_CAP 条带明细回传。
    in_library = 0
    for key in keys:
        if key in by_cdn:
            in_library += 1
        else:
            oid = _owned_image_id(key)
            if oid and oid in owned_ids:
                in_library += 1
    orphans = len(keys) - in_library

    items: list[dict] = []
    if preview:
        # 优先展示库外对象(运营更关心要导入哪些),其次已入库的
        orphan_keys = [k for k in keys if k not in by_cdn and not (
            (_owned_image_id(k) or "") in owned_ids)]
        in_lib_keys = [k for k in keys if k not in orphan_keys]
        ordered = orphan_keys + in_lib_keys
        for key in ordered[:_PREVIEW_CAP]:
            rec = by_cdn.get(key)
            if rec is None:
                oid = _owned_image_id(key)
                if oid and oid in owned_ids:
                    items.append({"object_key": key, "in_library": True, "image_id": oid,
                                  "preview_url": storage.public_url(key)})
                else:
                    items.append({"object_key": key, "in_library": False,
                                  "preview_url": storage.public_url(key)})
            else:
                iid, rev, listed, src = rec
                items.append({
                    "object_key": key, "in_library": True, "image_id": iid,
                    "review_status": rev, "is_listed": bool(listed), "source_type": src,
                    "preview_url": storage.public_url(key),
                })

    return {
        "configured": True,
        "total_objects": len(keys),
        "in_library": in_library,
        "orphans": orphans,
        "items": items,
        "items_capped": orphans + in_library > _PREVIEW_CAP,
    }


async def import_orphans(project_id: str, object_keys: list[str] | None = None) -> dict:
    """把库外对象导入灵图库(待审核 + 未上架),并派发 embed/tag 任务。

    object_keys 为空 → 导入 bucket 内全部库外对象;否则只导入指定的(且确为库外的)。
    返回 { imported, skipped, failed, image_ids[] }。
    """
    storage = get_storage()
    if not storage.is_read_configured():
        return {"imported": 0, "skipped": 0, "failed": 0, "image_ids": [], "error": "OSS 未配置"}

    scan = await scan_bucket()
    orphan_keys = [it["object_key"] for it in scan["items"] if not it["in_library"]]
    if object_keys:
        want = set(object_keys)
        orphan_keys = [k for k in orphan_keys if k in want]

    if not orphan_keys:
        return {"imported": 0, "skipped": 0, "failed": 0, "image_ids": []}

    _IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    imported_ids: list[str] = []
    failed = 0

    for key in orphan_keys:
        try:
            ext = Path(key).suffix.lstrip(".").lower() or "jpg"
            new_id = _uid()
            local = _IMPORT_DIR / f"{new_id}.{ext}"
            storage.download(key, str(local))

            with PILImage.open(local) as im:
                w, h = im.size
            file_hash = hashlib.md5(local.read_bytes()).hexdigest()

            async with async_session() as db:
                # 去重:同 hash 已在库则跳过(避免重复导入同一图的不同 key)
                dup = (await db.execute(
                    select(Image.id).where(Image.file_hash == file_hash).limit(1)
                )).scalar_one_or_none()
                if dup:
                    local.unlink(missing_ok=True)
                    continue
                img = Image(
                    id=new_id,
                    project_id=project_id,
                    file_path=str(local),
                    file_name=Path(key).name,
                    file_hash=file_hash,
                    width=w, height=h,
                    file_size_kb=local.stat().st_size // 1024,
                    quality_status="passed",      # OSS 直传图视为已过质检
                    review_status="pending",       # 待审核
                    is_listed=False,               # 未上架,需运营操作
                    tag_status="pending",
                    source_type="oss_import",
                    cdn_path=key,                  # 已在 bucket,直接复用其 key 作 CDN
                    relative_dir="oss_import",
                )
                db.add(img)
                await db.commit()
            imported_ids.append(new_id)
        except Exception as e:
            failed += 1
            logger.warning("OSS 导入对象失败 %s: %s", key, e)

    # 派发 embed + tag 任务,使导入图具备召回所需的向量 + 标签/描述
    if imported_ids:
        async with async_session() as db:
            for ttype in ("embed", "tag"):
                db.add(Task(
                    project_id=project_id,
                    type=ttype,
                    parameters=json.dumps({"image_ids": imported_ids}),
                    status="queued",
                    total=len(imported_ids),
                ))
            await db.commit()

    return {"imported": len(imported_ids), "skipped": 0, "failed": failed, "image_ids": imported_ids}


def _uid() -> str:
    from sidecar.db.models import _uid as model_uid
    return model_uid()
