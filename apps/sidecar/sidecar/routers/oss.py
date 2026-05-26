"""OSS sync admin endpoints — internal /api routes only.

POST /api/oss/test            — verify configured credentials by listing the bucket
GET  /api/oss/status          — queue stats (pending / running / done / failed)
POST /api/oss/backfill        — enqueue every image whose cdn_path is NULL
POST /api/oss/enqueue-images  — enqueue specific image_ids (selection-driven)
POST /api/oss/retry-failed    — reset failed jobs to pending
POST /api/oss/reset-local     — reset cdn_path=NULL + DELETE oss_sync_jobs (软重置,不动 OSS)
POST /api/oss/clear-remote    — 软重置 + 删 OSS 上 `i/` 前缀所有对象(危险,需 confirm token)
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, OssSyncJob
from sidecar.db.session import get_db
from sidecar.defaults import get_setting
from sidecar.engines.oss_sync import enqueue_image_sync, get_storage, invalidate_storage_cache

router = APIRouter()

logger = logging.getLogger(__name__)


class TestResult(BaseModel):
    ok: bool
    message: str = ""
    error: str = ""


@router.post("/test", response_model=TestResult)
async def test_connection():
    """Round-trip a HEAD on the bucket using oss2 to verify credentials.

    We pick a no-op operation: get bucket info. Failing oss2 calls raise an
    OssError with a status code; we surface a friendly message.
    """
    invalidate_storage_cache()
    storage = get_storage()
    if not storage.is_configured():
        return TestResult(ok=False, error="OSS 未配置")

    # oss2 calls are blocking — run via thread executor would be cleaner, but
    # this is a one-shot admin call; ms-level latency is fine.
    try:
        import oss2
        from oss2.exceptions import OssError
        bucket = storage._ensure_bucket()  # type: ignore[attr-defined]
        info = bucket.get_bucket_info()
        return TestResult(
            ok=True,
            message=f"连接成功 · bucket={info.name} · 区域={info.location}",
        )
    except Exception as e:  # broad: oss2 raises various subtypes
        msg = str(e)
        # Hide secret echoes in error messages
        return TestResult(ok=False, error=msg[:300])


@router.get("/status")
async def get_status(
    db: AsyncSession = Depends(get_db),
    probe_remote: bool = False,
):
    """Queue stats + sync coverage + throughput estimate for the dashboard.

    Two coverage modes:
      - `db_recorded`: 库里 cdn_path 字段标记为"同步过"的图(历史登记态,
        可能跟 OSS 实际不一致 — 例如 OSS 被外部清空、bucket 重建)
      - `remote_actual`: OSS 上 `i/` 前缀的真实对象数 — 持久化在 config 里
        - 用户点"刷新(含实时探测)" → probe_remote=true 触发新一次 list,
          结果写 config.json(`oss_last_remote_probe_*`)持久化
        - 平时 GET 不带 probe → 直接读 config 里的上次探测值显示
          (cache 不会自动过期,直到用户再次点刷新)
    """
    from datetime import datetime, timedelta
    from sidecar.routers.config_api import _read_config, _write_config

    rows = await db.execute(
        select(OssSyncJob.status, func.count(OssSyncJob.id))
        .group_by(OssSyncJob.status)
    )
    by_status = {s: int(n) for s, n in rows.all()}

    total_images = await db.scalar(select(func.count(Image.id))) or 0
    db_recorded = await db.scalar(
        select(func.count(Image.id)).where(Image.cdn_path.is_not(None))
    ) or 0

    pending = by_status.get("pending", 0)
    running = by_status.get("running", 0)

    # Throughput: jobs completed in the last 60s → estimate ETA
    one_min_ago = datetime.utcnow() - timedelta(seconds=60)
    recent_done = await db.scalar(
        select(func.count(OssSyncJob.id))
        .where(OssSyncJob.status == "done")
        .where(OssSyncJob.completed_at >= one_min_ago)
    ) or 0
    jobs_per_sec = recent_done / 60.0
    remaining_jobs = pending + running
    eta_sec = int(remaining_jobs / jobs_per_sec) if jobs_per_sec > 0 and remaining_jobs > 0 else None

    storage = get_storage()

    # 拿上次持久化的探测结果(无 cache 失效,直到下次 probe 主动覆盖)
    cfg = _read_config()
    cached_objects = cfg.get("oss_last_remote_probe_count")
    cached_at = cfg.get("oss_last_remote_probe_at")
    cached_objects = int(cached_objects) if isinstance(cached_objects, (int, float)) else None

    # 实时探测 OSS 上 `i/` 前缀的对象数(慢,只在 probe_remote=true 时跑)。
    # 每张图有 3 个 asset(original + thumb_300 + thumb_800),所以 unique
    # image 数 ≈ remote_objects / 3。前端展示时除一下。
    remote_objects: int | None = cached_objects   # 默认沿用 cache
    remote_probe_error: str | None = None
    probe_just_ran = False
    if probe_remote and storage.is_configured():
        try:
            import asyncio
            # storage.list_keys 是同步阻塞调用,跑在 thread pool 避免阻塞 event loop
            keys = await asyncio.to_thread(storage.list_keys, "i/")
            remote_objects = len(keys)
            probe_just_ran = True
            # 持久化新结果到 config(下次 GET 不带 probe 时仍能显示)
            cfg["oss_last_remote_probe_count"] = remote_objects
            cfg["oss_last_remote_probe_at"] = datetime.utcnow().isoformat()
            _write_config(cfg)
            cached_at = cfg["oss_last_remote_probe_at"]
        except Exception as e:
            msg = str(e)
            if "AccessDenied" in msg or "does not belong to you" in msg:
                remote_probe_error = "AK 缺少 oss:ListObjects 权限,请给 RAM 子账号挂 AliyunOSSFullAccess"
            else:
                remote_probe_error = msg[:200]
            logger.warning("oss probe_remote failed: %s", e)

    # 实时在云的 unique image 数(每图 3 个 asset)
    remote_synced_images = (remote_objects // 3) if remote_objects is not None else None

    return {
        "configured": storage.is_configured(),
        "provider": get_setting("oss_provider") or "",
        "bucket": get_setting("oss_bucket") or "",
        "cdn_base": get_setting("oss_cdn_base") or "",
        "queue": {
            "pending": pending,
            "running": running,
            "done": by_status.get("done", 0),
            "failed": by_status.get("failed", 0),
            "skipped": by_status.get("skipped", 0),
        },
        "throughput": {
            "jobs_per_min": recent_done,
            "eta_sec": eta_sec,
        },
        # coverage:同时返回两套数据,前端自己决定主推哪个
        "coverage": {
            "total_images": total_images,
            # 实时在云的 unique image 数(每图 3 asset = 原图 + 2 缩略)
            # 默认沿用 config 里上次探测的 cache;只有 probe_just_ran=True 才是新数
            "remote_synced_images": remote_synced_images,
            # 实时在云对象总数(3 × image 数 — 给精确显示用)
            "remote_objects": remote_objects,
            # 上次探测时间(ISO),前端能显示"探测于 5 分钟前"等
            "remote_probed_at": cached_at,
            # 这次请求是否真的跑了一次新探测(true=刚 list 完;false=用 cache)
            "remote_probe_just_ran": probe_just_ran,
            # 探测失败原因(只在 probe_remote=true 且失败时给)
            "remote_probe_error": remote_probe_error,
            # 数据库登记数(历史"应该同步过"的图,可能跟实际不一致)
            "db_recorded": db_recorded,
            # 旧字段兼容(老前端用 synced_images,新前端用 remote_synced_images)
            "synced_images": db_recorded,
            "pending_images": max(0, total_images - db_recorded),
            # 真实覆盖率优先用 remote,退回 db
            "pct": (
                (remote_synced_images / total_images)
                if (remote_synced_images is not None and total_images > 0)
                else ((db_recorded / total_images) if total_images > 0 else 0)
            ),
            # 数据库 vs 实际不一致提示(用户拍板要不要走 reset)
            "is_consistent": (
                remote_synced_images == db_recorded
                if remote_synced_images is not None
                else None
            ),
        },
    }


@router.get("/recent-jobs")
async def recent_jobs(limit: int = 20, db: AsyncSession = Depends(get_db)):
    """Most recent OSS sync jobs across all statuses, with image filename
    joined in. Powers the activity feed in the OSS sync UI."""
    limit = max(1, min(int(limit), 100))
    # Latest activity = newest by completed_at (or created_at if not done yet)
    rows = await db.execute(
        select(
            OssSyncJob.id,
            OssSyncJob.image_id,
            OssSyncJob.asset_kind,
            OssSyncJob.object_key,
            OssSyncJob.status,
            OssSyncJob.attempts,
            OssSyncJob.last_error,
            OssSyncJob.created_at,
            OssSyncJob.completed_at,
            Image.file_name,
        )
        .outerjoin(Image, Image.id == OssSyncJob.image_id)
        .order_by(OssSyncJob.id.desc())
        .limit(limit)
    )
    out = []
    for r in rows.all():
        out.append({
            "id": r[0],
            "image_id": r[1],
            "asset_kind": r[2],
            "object_key": r[3],
            "status": r[4],
            "attempts": r[5],
            "last_error": (r[6] or "")[:200] if r[6] else None,
            "created_at": r[7].isoformat() if r[7] else None,
            "completed_at": r[8].isoformat() if r[8] else None,
            "file_name": r[9],
        })
    return {"items": out}


class BackfillBody(BaseModel):
    project_id: Optional[str] = None
    limit: int = 0   # 0 = no cap


@router.post("/backfill")
async def backfill(body: BackfillBody, db: AsyncSession = Depends(get_db)):
    """Enqueue OSS sync for every image whose cdn_path is NULL."""
    storage = get_storage()
    if not storage.is_configured():
        raise HTTPException(400, "OSS 未配置；请先填写凭证并测试连接")

    q = select(Image.id).where(Image.cdn_path.is_(None))
    if body.project_id:
        q = q.where(Image.project_id == body.project_id)
    if body.limit and body.limit > 0:
        q = q.limit(body.limit)
    rows = await db.execute(q)
    image_ids = [r[0] for r in rows.all()]

    enqueued = 0
    for iid in image_ids:
        try:
            n = await enqueue_image_sync(iid)
            enqueued += n
        except Exception as e:
            logger.warning("backfill enqueue %s failed: %s", iid, e)
    return {"images": len(image_ids), "jobs_added": enqueued}


class EnqueueImagesBody(BaseModel):
    image_ids: list[str]
    force: bool = False     # if True, re-enqueue even already-synced images


@router.post("/enqueue-images")
async def enqueue_images(body: EnqueueImagesBody, db: AsyncSession = Depends(get_db)):
    """Enqueue OSS sync jobs for a specific selection of images. Used by
    the asset library's batch toolbar to sync just-filtered images
    (e.g. "this folder × this prompt × style=赛博朋克") instead of the
    whole library.

    Idempotent: a previously-done image is skipped unless force=True.
    """
    storage = get_storage()
    if not storage.is_configured():
        raise HTTPException(400, "OSS 未配置；请先在 OSS 同步页填凭证并测试连接")
    if not body.image_ids:
        raise HTTPException(400, "image_ids must be non-empty")

    # force=True: cdn_path 清空 + 在 enqueue_image_sync 里删 done jobs。
    # 两步缺一不可 — 之前老代码只清 cdn_path 但 done jobs 留着导致 enqueue
    # 跳过(2026-05-22 修)。
    if body.force:
        from sqlalchemy import update as sql_update
        await db.execute(
            sql_update(Image).where(Image.id.in_(body.image_ids)).values(cdn_path=None)
        )
        await db.commit()

    enqueued = 0
    for iid in body.image_ids:
        try:
            n = await enqueue_image_sync(iid, force=body.force)
            enqueued += n
        except Exception as e:
            logger.warning("enqueue %s failed: %s", iid, e)

    return {"images": len(body.image_ids), "jobs_added": enqueued, "force": body.force}


@router.post("/retry-failed")
async def retry_failed(db: AsyncSession = Depends(get_db)):
    """Reset failed jobs to pending so the worker picks them up again."""
    rows = await db.execute(
        select(func.count(OssSyncJob.id)).where(OssSyncJob.status == "failed")
    )
    n = int(rows.scalar_one() or 0)
    if n == 0:
        return {"reset": 0}
    await db.execute(
        update(OssSyncJob)
        .where(OssSyncJob.status == "failed")
        .values(status="pending", attempts=0, last_error=None)
    )
    await db.commit()
    return {"reset": n}


# ── 清空 / 重置 ─────────────────────────────────────────────────────────


class ResetBody(BaseModel):
    # 防误删:必须传形如 "RESET-2026-05-22" 的确认串(当天日期),
    # 否则拒绝。前端会自己拼好,但 curl 误调时挡一下。
    confirm: str
    # 选区软重置:只 reset 这些 image_id 的 cdn_path + 删它们关联的 jobs。
    # 空 / 未传 = 全量重置(老行为)。
    # 工作流场景:先用资产库强制重传一部分图(force=true),验证 OK 之后
    # 想对"剩下的图"批量软重置(让它们也走一遍同步),就把要 reset 的
    # 那部分 image_id 传进来,刚重传过的不动。
    image_ids: Optional[list[str]] = None


def _today_confirm() -> str:
    from datetime import datetime
    return "RESET-" + datetime.utcnow().strftime("%Y-%m-%d")


@router.post("/reset-local")
async def reset_local(body: ResetBody, db: AsyncSession = Depends(get_db)):
    """软重置:把所有 images.cdn_path 置空 + 删光 oss_sync_jobs,**不动 OSS bucket**。

    场景:想让所有图重新走一次本地同步流程(例如改了 storage 配置 / object_key 命名规则)。
    OSS 上原对象保留;后续 upload 同 key 自动 overwrite。

    需要传 confirm = `RESET-YYYY-MM-DD`(当天 UTC 日期)防误调。
    """
    if body.confirm != _today_confirm():
        raise HTTPException(400, {"code": "bad_confirm", "message": f"confirm 必须是 {_today_confirm()}"})

    from sqlalchemy import delete
    ids = body.image_ids or []

    if ids:
        img_n = await db.scalar(
            select(func.count(Image.id))
            .where(Image.id.in_(ids))
            .where(Image.cdn_path.is_not(None))
        ) or 0
        job_n = await db.scalar(
            select(func.count(OssSyncJob.id)).where(OssSyncJob.image_id.in_(ids))
        ) or 0
        await db.execute(
            update(Image)
            .where(Image.id.in_(ids))
            .where(Image.cdn_path.is_not(None))
            .values(cdn_path=None)
        )
        await db.execute(delete(OssSyncJob).where(OssSyncJob.image_id.in_(ids)))
    else:
        img_n = await db.scalar(
            select(func.count(Image.id)).where(Image.cdn_path.is_not(None))
        ) or 0
        job_n = await db.scalar(select(func.count(OssSyncJob.id))) or 0
        await db.execute(update(Image).where(Image.cdn_path.is_not(None)).values(cdn_path=None))
        await db.execute(delete(OssSyncJob))

    await db.commit()
    return {
        "scope": "selection" if ids else "all",
        "scope_size": len(ids) if ids else None,
        "images_reset": int(img_n),
        "jobs_deleted": int(job_n),
        "oss_objects_deleted": 0,
    }


@router.post("/reconcile")
async def reconcile(
    db: AsyncSession = Depends(get_db),
    force_push_all: bool = False,
):
    """对账 OSS 实际 vs 数据库 cdn_path,把 OSS 上没有但 db 里有标记的"幽灵图"
    cdn_path 设为 NULL。

    背景:db 里 `cdn_path` 字段是 worker 上传成功后写的,但如果 OSS 被外部清空
    /bucket 重建,db 里的 cdn_path 就成了"幽灵"。match 引擎有 cdn_required
    过滤,但只过滤 cdn_path 为 NULL 的;幽灵图 cdn_path 仍然有值,会被返回
    给 UGC → UGC 拿 URL 调 OSS → 404。

    解法:list OSS 上所有 i/ 前缀对象 → 取 unique image_id 集合 → db 里 cdn_path
    非空但不在这个集合的图,cdn_path 设 NULL。同时这个变更会被 cloud_sync
    推到云端 sidecar(如果配置了 cloud sync),云端 match 也跟着对齐。
    """
    storage = get_storage()
    if not storage.is_configured():
        raise HTTPException(400, {"code": "oss_not_configured", "message": "OSS 未配置,无法对账"})

    # 1. 拉 OSS i/ 前缀全 list,提取 unique image_id
    try:
        import asyncio
        keys = await asyncio.to_thread(storage.list_keys, "i/")
    except Exception as e:
        msg = str(e)
        if "AccessDenied" in msg or "does not belong to you" in msg:
            raise HTTPException(502, {"code": "list_failed",
                "message": "AK 缺 oss:ListObjects 权限,挂 AliyunOSSFullAccess"})
        raise HTTPException(502, {"code": "list_failed", "message": f"list 失败: {msg[:200]}"})

    on_oss_ids: set[str] = set()
    for k in keys:
        # key 格式: i/<image_id>.<ext> 或 i/<image_id>_300.jpg
        if not k.startswith("i/"):
            continue
        body_part = k[2:]
        if "_300" in body_part or "_800" in body_part:
            continue
        iid = body_part.rsplit(".", 1)[0]
        on_oss_ids.add(iid)

    # 2. 拉 db 里 cdn_path 非空的图
    rows = await db.execute(select(Image.id).where(Image.cdn_path.is_not(None)))
    db_with_cdn = set(r[0] for r in rows.all())

    # 3. 幽灵集合:db 有标记但 OSS 没有
    ghost_ids = db_with_cdn - on_oss_ids

    # force_push_all 模式:即使 db 已对齐,也把所有 image 入 cloud sync 队列
    # 重推到云端(用来修复"db 已对齐但云端没收到"的状态)
    if not ghost_ids and not force_push_all:
        return {
            "on_oss": len(on_oss_ids),
            "db_with_cdn": len(db_with_cdn),
            "ghost_cleared": 0,
            "message": "数据库与 OSS 已一致,无需 reconcile(传 force_push_all=true 强制重推到云端)",
        }

    # 4. 批量 update(分块,避免 IN 子句过长)
    cleared = 0
    ghost_list = list(ghost_ids)
    CHUNK = 500
    for i in range(0, len(ghost_list), CHUNK):
        chunk = ghost_list[i:i + CHUNK]
        await db.execute(
            update(Image).where(Image.id.in_(chunk)).values(cdn_path=None)
        )
        cleared += len(chunk)
    await db.commit()

    # 5. 同步删 oss_sync_jobs 里这些图的 done 状态(让重新 enqueue 能创建 pending)
    from sqlalchemy import delete as sql_delete
    for i in range(0, len(ghost_list), CHUNK):
        chunk = ghost_list[i:i + CHUNK]
        await db.execute(
            sql_delete(OssSyncJob)
            .where(OssSyncJob.image_id.in_(chunk))
            .where(OssSyncJob.status == "done")
        )
    await db.commit()

    # 6. 关键!把图入 cloud_sync_jobs 队列 — 否则云端不知道 cdn_path 变了,
    # UGC 还是返回幽灵图给客户端 → 还是 404。
    #
    # ghost_list:这次清空的图,云端 cdn_path 也要清空(否则云端 match 拿
    #            到 cdn_path 非空就返回 → UGC 404)
    # force_push_all:不止 ghost,把 ALL image 重推一遍。修复"db 已对齐但
    #                之前 reconcile 没入队"导致的云端没同步状态。
    cloud_sync_enqueued = 0
    push_ids = ghost_list[:]
    if force_push_all:
        # 拉所有 image_id(approved 状态,跟 cloud sync worker 推送条件一致)
        all_rows = await db.execute(select(Image.id))
        all_ids = [r[0] for r in all_rows.all()]
        push_set = set(push_ids) | set(all_ids)
        push_ids = list(push_set)

    try:
        from sidecar.scheduler.cloud_sync_worker import enqueue_image_upsert
        from sidecar.config import LINTU_CLOUD_SYNC_URL
        if LINTU_CLOUD_SYNC_URL and push_ids:
            for iid in push_ids:
                try:
                    await enqueue_image_upsert(iid)
                    cloud_sync_enqueued += 1
                except Exception as e:
                    logger.warning("cloud sync enqueue failed for %s: %s", iid, str(e)[:80])
    except Exception as e:
        logger.warning("cloud sync enqueue stage failed: %s", e)

    return {
        "on_oss": len(on_oss_ids),
        "db_with_cdn_before": len(db_with_cdn),
        "ghost_cleared": cleared,
        "db_with_cdn_after": len(db_with_cdn) - cleared,
        "cloud_sync_enqueued": cloud_sync_enqueued,
        "message": (
            f"已把 {cleared} 张幽灵图 cdn_path 清空 + 入 cloud sync 队列推到云端。"
            f"OSS 实际有 {len(on_oss_ids)} 张图。"
            f"cloud sync 推送完成后(30-60s),云端 match 引擎自动只返回 OSS 上的图。"
        ),
    }


@router.post("/clear-remote")
async def clear_remote(body: ResetBody, db: AsyncSession = Depends(get_db)):
    """全清:软重置 + 删 OSS bucket 上 `i/` 前缀所有对象(只删 lintu 同步的,
    不动其他前缀的对象)。

    OSS 删除走 batch_delete_objects(1000/批),`i/` 前缀全 listing 后批量删。
    需要 confirm = `RESET-YYYY-MM-DD`。
    """
    if body.confirm != _today_confirm():
        raise HTTPException(400, {"code": "bad_confirm", "message": f"confirm 必须是 {_today_confirm()}"})

    storage = get_storage()
    if not storage.is_configured():
        raise HTTPException(400, {"code": "oss_not_configured", "message": "OSS 未配置,无法清远端"})

    # AccessDenied 提示生成器 — 阿里云 OSS "does not belong to you" 实际是
    # RAM 子账号 policy 不全(只授了 PutObject)。给出可操作建议。
    def _humanize_oss_err(op: str, e: Exception) -> str:
        msg = str(e)
        if "AccessDenied" in msg or "does not belong to you" in msg:
            need = {"list": "oss:ListObjects + oss:GetBucket",
                    "delete": "oss:DeleteObject + oss:DeleteMultipleObjects"}.get(op, "oss:*")
            return (
                f"{op} 被 OSS 拒绝。AK 子账号缺少权限({need})。\n\n"
                f"解决:阿里云控制台 → RAM → 用户 → 该 AK → 权限管理 → 加 'AliyunOSSFullAccess' 系统策略(简单),"
                f"或自定义 policy 加上述 action。详情:{msg[:200]}"
            )
        return f"{op} 失败: {msg[:300]}"

    # 1. 拉 OSS i/ 前缀全 list
    try:
        keys = storage.list_keys(prefix="i/")
    except Exception as e:
        logger.exception("list_keys failed")
        raise HTTPException(502, {"code": "list_failed", "message": _humanize_oss_err("list", e)})

    # 2. 批量删
    deleted = 0
    if keys:
        try:
            deleted = storage.delete_keys(keys)
        except Exception as e:
            logger.exception("delete_keys failed")
            raise HTTPException(502, {"code": "delete_failed", "message": _humanize_oss_err("delete", e)})

    # 3. 软重置本地
    img_n = await db.scalar(
        select(func.count(Image.id)).where(Image.cdn_path.is_not(None))
    ) or 0
    job_n = await db.scalar(select(func.count(OssSyncJob.id))) or 0
    await db.execute(update(Image).where(Image.cdn_path.is_not(None)).values(cdn_path=None))
    from sqlalchemy import delete
    await db.execute(delete(OssSyncJob))
    await db.commit()

    return {
        "images_reset": int(img_n),
        "jobs_deleted": int(job_n),
        "oss_objects_listed": len(keys),
        "oss_objects_deleted": deleted,
    }
