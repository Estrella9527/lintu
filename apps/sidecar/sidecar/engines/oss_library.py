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

import httpx
from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.config import (
    DATA_DIR, LINTU_CLOUD_SYNC_URL, LINTU_INTERNAL_SYNC_TOKEN, WORKSPACE_DIR,
)
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

# 扫描结果缓存:打开 OSS 图库秒出上次结果,不必每次全列 bucket(LIST 翻页 +
# 云端联查要数秒)。「重新扫描」或缓存超龄时后台刷新。
_CACHE_FILE = DATA_DIR / "oss_library_cache.json"


def _read_cache() -> dict | None:
    try:
        if _CACHE_FILE.exists():
            d = json.loads(_CACHE_FILE.read_text())
            if isinstance(d.get("keys"), list):
                return d
    except Exception:
        logger.warning("oss_library: 读缓存失败,将重扫", exc_info=True)
    return None


def _write_cache(keys: list[str], cloud_map: dict) -> None:
    try:
        _CACHE_FILE.write_text(json.dumps({
            "scanned_at": datetime.utcnow().isoformat(),
            "keys": keys,
            "cloud": cloud_map,
        }, ensure_ascii=False))
    except Exception:
        logger.warning("oss_library: 写缓存失败", exc_info=True)


async def _query_cloud_briefs(keys: list[str]) -> dict[str, dict]:
    """问云端:这些对象 key 对应的图,组织里是否已有别的电脑发布过信息。

    返回 {object_key: brief};brief 含 id/file_name/review_status/is_listed/
    tag_count/description。匹配按 (cdn_path == key) 或 (key 解析出的 id)。
    未配置同步凭据(用户版)或云端不可达 → 空 map,不报错。
    """
    if not keys or not LINTU_CLOUD_SYNC_URL or not LINTU_INTERNAL_SYNC_TOKEN:
        return {}
    parsed_ids = [oid for oid in (_owned_image_id(k) for k in keys) if oid]
    url = f"{LINTU_CLOUD_SYNC_URL.rstrip('/')}/internal/sync/images-brief"
    headers = {"Authorization": f"Bearer {LINTU_INTERNAL_SYNC_TOKEN}"}
    out: dict[str, dict] = {}
    by_id: dict[str, dict] = {}
    by_cdn: dict[str, dict] = {}
    try:
        async with httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(10, read=60)) as client:
            CHUNK = 800
            for i in range(0, max(len(keys), len(parsed_ids)), CHUNK):
                body = {"ids": parsed_ids[i:i + CHUNK], "cdn_paths": keys[i:i + CHUNK]}
                r = await client.post(url, json=body)
                if r.status_code >= 400:
                    logger.warning("oss_library: 云端联查 %s — %s", r.status_code, r.text[:120])
                    return {}
                for it in (r.json().get("items") or []):
                    if it.get("id"):
                        by_id[it["id"]] = it
                    if it.get("cdn_path"):
                        by_cdn[it["cdn_path"]] = it
        for k in keys:
            brief = by_cdn.get(k)
            if brief is None:
                oid = _owned_image_id(k)
                if oid:
                    brief = by_id.get(oid)
            if brief is not None:
                out[k] = brief
    except Exception as e:
        logger.warning("oss_library: 云端联查失败(降级为不显示云端信息): %s", str(e)[:120])
        return {}
    return out


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


async def _load_context(refresh: bool = False):
    """取 bucket 原图 key 列表 + 本机库映射 + 云端发布信息。scan / list_objects 共用。

    缓存策略(用户反馈"每次打开都要同步很久"):
      - keys(OSS LIST)和云端联查结果走本地缓存文件 —— 打开秒出;
      - 本机库映射(by_cdn/owned_ids)每次现查本地 DB(便宜,导入/上架立即反映);
      - refresh=True(「重新扫描」)→ 重列 bucket + 重新云端联查 + 重写缓存。
    返回 (storage, keys, by_cdn, owned_ids, cloud_map, scanned_at, cache_hit)。
    """
    storage = get_storage()
    cache = None if refresh else _read_cache()
    if cache is not None:
        keys: list[str] = cache["keys"]
        cloud_map: dict[str, dict] = cache.get("cloud") or {}
        scanned_at: str | None = cache.get("scanned_at")
        cache_hit = True
    else:
        keys = [k for k in storage.list_keys(_IMG_PREFIX) if not _is_thumb(k)]
        # 云端联查放在"非本机"的 key 上意义最大,但本机映射还没取;
        # 直接全量问(云端按 id/cdn_path 命中,几千个 id 一次 IN 查询很快)。
        cloud_map = await _query_cloud_briefs(keys)
        scanned_at = datetime.utcnow().isoformat()
        _write_cache(keys, cloud_map)
        cache_hit = False

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
    return storage, keys, by_cdn, owned_ids, cloud_map, scanned_at, cache_hit


def _classify(key: str, by_cdn: dict, owned_ids: set, cloud_map: dict) -> dict:
    """单个对象 key 三态判定:
      local  已入库(本机灵图在管理,信息最全)
      cloud  云端已发布(别的电脑发布的,远端有完整信息,本机无文件)
      orphan 未纳管(纯 OSS 文件,任何电脑都没导入过)
    in_library 字段保留 = (status=='local'),兼容旧前端。"""
    rec = by_cdn.get(key)
    if rec is not None:
        iid, rev, listed, src = rec
        return {"object_key": key, "status": "local", "in_library": True, "image_id": iid,
                "review_status": rev, "is_listed": bool(listed), "source_type": src}
    oid = _owned_image_id(key)
    if oid and oid in owned_ids:
        return {"object_key": key, "status": "local", "in_library": True, "image_id": oid}
    brief = cloud_map.get(key)
    if brief is not None:
        return {"object_key": key, "status": "cloud", "in_library": False,
                "image_id": brief.get("id"),
                "review_status": brief.get("review_status"),
                "is_listed": bool(brief.get("is_listed")),
                "cloud_file_name": brief.get("file_name"),
                "cloud_tag_count": brief.get("tag_count")}
    return {"object_key": key, "status": "orphan", "in_library": False}


async def scan_bucket(preview: bool = True, refresh: bool = False) -> dict:
    """扫描 bucket:返回汇总 + 目录树(dirs)+ 预览明细(items, 最多 _PREVIEW_CAP)。

    dirs: [{ folder, count, in_library, cloud, orphans }];orphans 现在指
    「未纳管」(本机没有、云端也没发布过)。scanned_at/cache_hit 供前端展示
    "上次扫描 X 前"。
    """
    storage = get_storage()
    if not storage.is_read_configured():
        return {"configured": False, "total_objects": 0, "in_library": 0,
                "cloud": 0, "orphans": 0, "items": [], "dirs": [],
                "scanned_at": None, "cache_hit": False}

    _s, keys, by_cdn, owned_ids, cloud_map, scanned_at, cache_hit = await _load_context(refresh)

    n_local = n_cloud = 0
    # 目录聚合:folder → [total, local, cloud]
    dir_agg: dict[str, list[int]] = {}
    for key in keys:
        info = _classify(key, by_cdn, owned_ids, cloud_map)
        st = info["status"]
        if st == "local":
            n_local += 1
        elif st == "cloud":
            n_cloud += 1
        d = dir_agg.setdefault(_dir_of(key), [0, 0, 0])
        d[0] += 1
        if st == "local":
            d[1] += 1
        elif st == "cloud":
            d[2] += 1
    orphans = len(keys) - n_local - n_cloud
    dirs = [
        {"folder": folder, "count": tot, "in_library": loc, "cloud": cld,
         "orphans": tot - loc - cld}
        for folder, (tot, loc, cld) in sorted(dir_agg.items())
    ]

    items: list[dict] = []
    if preview:
        # 优先展示未纳管(运营更关心要导入哪些),其次云端,最后本机已入库
        order = {"orphan": 0, "cloud": 1, "local": 2}
        classified = [(_classify(k, by_cdn, owned_ids, cloud_map)) for k in keys]
        classified.sort(key=lambda it: order[it["status"]])
        for info in classified[:_PREVIEW_CAP]:
            items.append({**info, "preview_url": storage.public_url(info["object_key"])})

    return {
        "configured": True,
        "total_objects": len(keys),
        "in_library": n_local,
        "cloud": n_cloud,
        "orphans": orphans,
        "dirs": dirs,
        "items": items,
        "items_capped": len(keys) > _PREVIEW_CAP,
        "scanned_at": scanned_at,
        "cache_hit": cache_hit,
    }


async def list_objects(prefix: str | None = None, only: str = "all",
                       offset: int = 0, limit: int = 120) -> dict:
    """按目录前缀 + 过滤分页列对象(资产库 OSS 图库网格用)。

    prefix: None=全部目录;""=根目录;"i"/"uploads/2024"=该目录(精确,不含子目录)。
    only:   'all' | 'orphan'(未纳管) | 'cloud'(云端已发布) | 'in_library'(本机已入库)。
    返回 { items:[...含 preview_url], total }。走缓存 keys,不重列 bucket。
    """
    storage = get_storage()
    if not storage.is_read_configured():
        return {"configured": False, "items": [], "total": 0}

    _s, keys, by_cdn, owned_ids, cloud_map, _sa, _ch = await _load_context()

    # 目录过滤(精确匹配该目录,子目录算它自己的目录,符合资产库"文件夹"直观)
    if prefix is not None:
        keys = [k for k in keys if _dir_of(k) == prefix]

    classified = [_classify(k, by_cdn, owned_ids, cloud_map) for k in keys]
    if only == "orphan":
        classified = [c for c in classified if c["status"] == "orphan"]
    elif only == "cloud":
        classified = [c for c in classified if c["status"] == "cloud"]
    elif only == "in_library":
        classified = [c for c in classified if c["status"] == "local"]

    # 未纳管在前(运营优先处理),云端次之,稳定排序
    order = {"orphan": 0, "cloud": 1, "local": 2}
    classified.sort(key=lambda it: (order[it["status"]], it["object_key"]))
    total = len(classified)
    page = classified[offset:offset + limit]
    items = [{**info, "preview_url": storage.public_url(info["object_key"])} for info in page]
    return {"configured": True, "items": items, "total": total}


async def cloud_image_detail(image_id: str) -> dict | None:
    """单张云端已发布图的完整信息(含标签),给详情面板用。本机代云端查,
    渲染层不接触同步凭据。云端不可达/没配凭据 → None。"""
    if not LINTU_CLOUD_SYNC_URL or not LINTU_INTERNAL_SYNC_TOKEN:
        return None
    url = f"{LINTU_CLOUD_SYNC_URL.rstrip('/')}/internal/sync/image-brief/{image_id}"
    headers = {"Authorization": f"Bearer {LINTU_INTERNAL_SYNC_TOKEN}"}
    try:
        async with httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(10, read=30)) as client:
            r = await client.get(url)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
    except Exception as e:
        logger.warning("oss_library: 云端详情查询失败 %s: %s", image_id, str(e)[:120])
        return None


async def import_orphans(project_id: str, object_keys: list[str] | None = None) -> dict:
    """把库外对象导入灵图库(待审核 + 未上架),并派发 embed/tag 任务。

    object_keys 为空 → 导入 bucket 内全部库外对象;否则只导入指定的(且确为库外的)。
    返回 { imported, skipped, failed, image_ids[] }。
    """
    storage = get_storage()
    if not storage.is_read_configured():
        return {"imported": 0, "skipped": 0, "failed": 0, "image_ids": [], "error": "OSS 未配置"}

    # 直接全量分类(不走 scan 的预览明细 — 那个有 500 条上限,会漏导)。
    # 「导入全部」只导真正未纳管的(orphan);云端已发布的图是组织资产,
    # 重复导入会生成第二条记录 — 想在本机用它,开「多设备同步」即可。
    _s, keys, by_cdn, owned_ids, cloud_map, _sa, _ch = await _load_context()
    orphan_keys = [
        k for k in keys
        if _classify(k, by_cdn, owned_ids, cloud_map)["status"] == "orphan"
    ]
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
