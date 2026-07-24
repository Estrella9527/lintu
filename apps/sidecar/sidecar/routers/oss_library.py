"""OSS 图库 —— 扫描 bucket、把库外对象反向导入灵图库。

UGC 需求(2026-06):OSS bucket 里有库外图(外部直传),需要让它们进入
灵图库后由用户决定是否上架参与匹配。这个 router 给「匹配策略 → OSS 图库」入口用。

  GET  /api/oss-library/scan                 扫描 bucket,返回每个对象的入库/审核/上架状态
  POST /api/oss-library/import               导入库外对象(直接入图库+未上架),派发 embed/tag
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from typing import Optional

from fastapi import Query

from sidecar.engines.oss_library import (
    cloud_image_detail, delete_bucket_objects, import_orphans, list_objects,
    scan_bucket,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/scan")
async def scan(refresh: bool = Query(False, description="true=重列 bucket + 重新云端联查(否则用缓存秒回)")):
    """扫描 OSS bucket,返回汇总 + 目录树 + 预览明细。默认走缓存(秒开),
    refresh=true 时真正重扫并刷新缓存。"""
    try:
        return await scan_bucket(refresh=refresh)
    except Exception as e:
        logger.exception("OSS 扫描失败")
        raise HTTPException(500, {"code": "scan_failed", "message": str(e)})


@router.get("/objects")
async def objects(
    prefix: Optional[str] = Query(None, description='目录前缀;不传=全部,""=根目录'),
    only: str = Query("all", description="all | orphan(未纳管) | cloud(云端已发布) | in_library(本机已入库)"),
    offset: int = Query(0, ge=0),
    limit: int = Query(120, ge=1, le=500),
):
    """按目录 + 过滤分页列 OSS 对象(资产库 OSS 图库网格)。走缓存不重列 bucket。"""
    try:
        return await list_objects(prefix=prefix, only=only, offset=offset, limit=limit)
    except Exception as e:
        logger.exception("OSS 列对象失败")
        raise HTTPException(500, {"code": "list_failed", "message": str(e)})


@router.get("/cloud-image/{image_id}")
async def cloud_image(image_id: str):
    """云端已发布图的完整信息(含标签)。本机 sidecar 代云端查询,
    渲染层不接触同步凭据。"""
    try:
        detail = await cloud_image_detail(image_id)
    except Exception as e:
        logger.exception("云端图片详情查询失败")
        raise HTTPException(502, {"code": "cloud_query_failed", "message": str(e)})
    if detail is None:
        raise HTTPException(404, {"code": "not_found", "message": "云端无此图或未配置同步凭据"})
    return detail


class DeleteObjectsBody(BaseModel):
    object_keys: list[str]
    # True = 本机已入库的对象连同灵图记录(本地+云端)一起删;False = 只删未纳管文件
    delete_records: bool = False


@router.post("/delete-objects")
async def delete_objects(body: DeleteObjectsBody):
    """删除 OSS 仓文件。未纳管直接删;本机已入库需 delete_records=true(连记录);
    云端已发布一律跳过(由发布端管理)。"""
    if not body.object_keys:
        return {"deleted_objects": 0, "deleted_records": 0, "skipped_local": 0, "skipped_cloud": 0}
    try:
        return await delete_bucket_objects(body.object_keys, body.delete_records)
    except Exception as e:
        logger.exception("OSS 删除对象失败")
        raise HTTPException(500, {"code": "delete_failed", "message": str(e)})


class ImportBody(BaseModel):
    project_id: str
    # 不传 = 导入全部库外对象;传了 = 只导入指定 key(且确为库外的)
    object_keys: list[str] | None = None


@router.post("/import")
async def do_import(body: ImportBody):
    """把库外对象导入灵图库:下载 → 建 Image 行(图库已确认+未上架,cdn_path=key)
    → 派发 embed + tag 任务。导入后仅在用户上架时进入 UGC 匹配池。"""
    if not body.project_id:
        raise HTTPException(400, {"code": "missing_project", "message": "project_id 必填"})
    try:
        return await import_orphans(body.project_id, body.object_keys)
    except Exception as e:
        logger.exception("OSS 导入失败")
        raise HTTPException(500, {"code": "import_failed", "message": str(e)})
