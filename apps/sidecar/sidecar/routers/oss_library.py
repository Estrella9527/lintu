"""OSS 图库 —— 扫描 bucket、把库外对象反向导入灵图库。

UGC 需求(2026-06):OSS bucket 里有库外图(外部直传),需要让它们进入
灵图库参与审核+上架+匹配。这个 router 给「匹配策略 → OSS 图库」入口用。

  GET  /api/oss-library/scan                 扫描 bucket,返回每个对象的入库/审核/上架状态
  POST /api/oss-library/import               导入库外对象(待审核+未上架),派发 embed/tag
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from sidecar.engines.oss_library import scan_bucket, import_orphans

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/scan")
async def scan():
    """扫描 OSS bucket,返回对象清单 + 入库/审核/上架状态汇总。"""
    try:
        return await scan_bucket()
    except Exception as e:
        logger.exception("OSS 扫描失败")
        raise HTTPException(500, {"code": "scan_failed", "message": str(e)})


class ImportBody(BaseModel):
    project_id: str
    # 不传 = 导入全部库外对象;传了 = 只导入指定 key(且确为库外的)
    object_keys: list[str] | None = None


@router.post("/import")
async def do_import(body: ImportBody):
    """把库外对象导入灵图库:下载 → 建 Image 行(待审核+未上架,cdn_path=key)
    → 派发 embed + tag 任务。导入后需运营审核 + 上架才进 UGC 匹配池。"""
    if not body.project_id:
        raise HTTPException(400, {"code": "missing_project", "message": "project_id 必填"})
    try:
        return await import_orphans(body.project_id, body.object_keys)
    except Exception as e:
        logger.exception("OSS 导入失败")
        raise HTTPException(500, {"code": "import_failed", "message": str(e)})
