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


def _dir_of(key: str) -> str:
    """对象 key 的"目录"部分(最后一个 / 之前);无 / 则归根目录 ""。
    例:i/abc.jpg → 'i';uploads/2024/x.jpg → 'uploads/2024';foo.jpg → ''。"""
    i = key.rfind("/")
    return key[:i] if i >= 0 else ""


_PREVIEW_CAP = 500  # items 明细 + preview_url 上限,避免一次回传/签名上千条


async def _load_context():
    """拉 bucket 全量原图 key + 库内 cdn/owned 映射。scan / list_objects 共用。
    返回 (storage, keys, by_cdn, owned_ids)。"""
    storage = get_storage()
    keys = [k for k in storage.list_keys(_IMG_PREFIX) if not _is_thumb(k)]
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
    return storage, keys, by_cdn, owned_ids


def _classify(key: str, by_cdn: dict, owned_ids: set) -> dict:
    """把单个 object key 判成 库内/库外 + 带上审核/上架态。不含 preview_url。"""
    rec = by_cdn.get(key)
    if rec is not None:
        iid, rev, listed, src = rec
        return {"object_key": key, "in_library": True, "image_id": iid,
                "review_status": rev, "is_listed": bool(listed), "source_type": src}
    oid = _owned_image_id(key)
    if oid and oid in owned_ids:
        return {"object_key": key, "in_library": True, "image_id": oid}
    return {"object_key": key, "in_library": False}


async def scan_bucket(preview: bool = True) -> dict:
    """扫描 bucket:返回汇总 + 目录树(dirs)+ 预览明细(items, 最多 _PREVIEW_CAP)。

    dirs: [{ folder, count, in_library, orphans }] —— 供资产库 OSS 图库左侧
    目录树(按 object key 前缀分组)。
    """
    storage = get_storage()
    if not storage.is_read_configured():
        return {"configured": False, "total_objects": 0, "in_library": 0,
                "orphans": 0, "items": [], "dirs": []}

    _s, keys, by_cdn, owned_ids = await _load_context()

    in_library = 0
    # 目录聚合:folder → [total, in_library]
    dir_agg: dict[str, list[int]] = {}
    for key in keys:
        info = _classify(key, by_cdn, owned_ids)
        is_in = info["in_library"]
        if is_in:
            in_library += 1
        d = dir_agg.setdefault(_dir_of(key), [0, 0])
        d[0] += 1
        if is_in:
            d[1] += 1
    orphans = len(keys) - in_library
    dirs = [
        {"folder": folder, "count": tot, "in_library": inlib, "orphans": tot - inlib}
        for folder, (tot, inlib) in sorted(dir_agg.items())
    ]

    items: list[dict] = []
    if preview:
        # 优先展示库外对象(运营更关心要导入哪些),其次已入库的
        classified = [(_classify(k, by_cdn, owned_ids)) for k in keys]
        classified.sort(key=lambda it: it["in_library"])  # False(库外) 在前
        for info in classified[:_PREVIEW_CAP]:
            items.append({**info, "preview_url": storage.public_url(info["object_key"])})

    return {
        "configured": True,
        "total_objects": len(keys),
        "in_library": in_library,
        "orphans": orphans,
        "dirs": dirs,
        "items": items,
        "items_capped": orphans + in_library > _PREVIEW_CAP,
    }


async def list_objects(prefix: str | None = None, only: str = "all",
                       offset: int = 0, limit: int = 120) -> dict:
    """按目录前缀 + 过滤分页列对象(资产库 OSS 图库网格用)。

    prefix: None=全部目录;""=根目录;"i"/"uploads/2024"=该目录(精确,不含子目录)。
    only:   'all' | 'orphan'(库外) | 'in_library'(已入库)。
    返回 { items:[...含 preview_url], total }。
    """
    storage = get_storage()
    if not storage.is_read_configured():
        return {"configured": False, "items": [], "total": 0}

    _s, keys, by_cdn, owned_ids = await _load_context()

    # 目录过滤(精确匹配该目录,子目录算它自己的目录,符合资产库"文件夹"直观)
    if prefix is not None:
        keys = [k for k in keys if _dir_of(k) == prefix]

    classified = [_classify(k, by_cdn, owned_ids) for k in keys]
    if only == "orphan":
        classified = [c for c in classified if not c["in_library"]]
    elif only == "in_library":
        classified = [c for c in classified if c["in_library"]]

    # 库外在前,稳定排序便于运营批量处理
    classified.sort(key=lambda it: (it["in_library"], it["object_key"]))
    total = len(classified)
    page = classified[offset:offset + limit]
    items = [{**info, "preview_url": storage.public_url(info["object_key"])} for info in page]
    return {"configured": True, "items": items, "total": total}


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
