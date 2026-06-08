"""Unified canvas image generation endpoint — POST /api/generate.

All 7 canvas AI ops (Ask AI / outpaint / inpaint / matting / eraser /
upscale / text-zh) + text2img + img2img share this single endpoint.
The dispatcher (engines/generation_dispatch.py) decides which provider
method and prompt prefix to use per `type`.

Phase 1 design notes:
- Synchronous (5-30s round-trip is acceptable for single-image canvas ops).
  Phase 2 will introduce SSE for long-running outpaint at 4K.
- Persists candidates straight to disk + creates ImageRecord rows under
  `<project>/uploads/generated/<yyyymmdd>/`, so the canvas can drop them
  into the asset library with zero extra work.
- Errors come back as structured JSON `{ok: false, error: {code, message}}`
  with the right HTTP status. We do NOT raise unhandled 500s — the canvas
  needs to show a clean toast, not "Internal Server Error".
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from PIL import Image as PILImage
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, Project
from sidecar.db.session import get_db
from sidecar.engines.generation_dispatch import (
    GenerationCandidate,
    GenerationFailure,
    VALID_TYPES,
    dispatch,
)
from sidecar.engines.aigc_label import embed_aigc_label_png
from sidecar.engines.image_utils import compute_perceptual_hashes
from sidecar.engines.oss_sync import enqueue_image_sync

logger = logging.getLogger(__name__)

router = APIRouter()


class GenerateRequest(BaseModel):
    """Mirror of the contract documented in v0.3 plan §4 PR-1 + §10 PR-8."""
    type: Literal[
        "text2img", "img2img", "outpaint", "inpaint",
        "matting", "eraser", "upscale", "text-zh", "edit",
    ]
    project_id: str
    prompt: Optional[str] = None
    instruction: Optional[str] = None
    input_image_id: Optional[str] = None
    mask: Optional[str] = None              # base64 PNG (with or w/o data: prefix);白=改 黑=保
    target_w: Optional[int] = Field(None, ge=64, le=8192)
    target_h: Optional[int] = Field(None, ge=64, le=8192)
    # outpaint 时控制原图在目标 canvas 内的位置;不传走 center/middle
    align_x: Optional[Literal["left", "center", "right"]] = None
    align_y: Optional[Literal["top", "middle", "bottom"]] = None
    style_archive_id: Optional[str] = None  # v0.3 PR-8 真接入:description 拼 prompt 前缀
    strength: Optional[float] = Field(None, ge=0.0, le=1.0)
    consistency: Optional[float] = Field(None, ge=0.0, le=1.0)
    speed: Optional[Literal["draft", "refined"]] = "refined"
    model_id: Optional[str] = None
    count: int = Field(1, ge=1, le=4)


def _decode_mask(mask_b64: str | None) -> bytes | None:
    """前端可能传 'data:image/png;base64,...' 或裸 base64;两种都吃。"""
    if not mask_b64:
        return None
    import base64
    raw = mask_b64.strip()
    if raw.startswith("data:"):
        # 切掉 data:image/png;base64, 前缀
        comma = raw.find(",")
        if comma > 0:
            raw = raw[comma + 1:]
    try:
        return base64.b64decode(raw)
    except Exception:
        raise HTTPException(400, {"code": "invalid_mask", "message": "mask 必须是 base64 PNG"})


async def _persist_candidate(
    db: AsyncSession,
    project: Project,
    cand: GenerationCandidate,
    *,
    gtype: str,
    parent_id: str | None,
    prompt_for_meta: str,
) -> Image:
    """Drop a candidate's bytes to disk + INSERT an ImageRecord row.

    Stored under `<originals>/uploads/generated/<yyyymmdd>/<hash>.png`
    so generation outputs surface naturally in the asset library, same
    namespace convention as the manual-upload flow (PR-235 in v0.2).
    """
    today = datetime.utcnow().strftime("%Y%m%d")
    dest_dir = Path(project.originals_path) / "uploads" / "generated" / today
    dest_dir.mkdir(parents=True, exist_ok=True)

    # 合规:写盘前嵌入 AIGC 隐式标识(《AI生成合成内容标识办法》)。
    # 标识跟着文件走,转存/分发后仍在。失败会返回原字节,不阻断生成。
    labeled = embed_aigc_label_png(cand.image_data, gtype=gtype)

    file_hash = hashlib.md5(labeled).hexdigest()
    # All providers return PNG-decodable bytes; we don't try to preserve the
    # exact upstream format because most return b64 PNG anyway.
    out_path = dest_dir / f"{file_hash}.png"
    if not out_path.exists():
        out_path.write_bytes(labeled)

    try:
        with PILImage.open(out_path) as pil:
            width, height = pil.size
    except Exception:
        out_path.unlink(missing_ok=True)
        raise GenerationFailure("invalid_image", "Provider returned undecodable bytes", status=502)

    phash_dict = compute_perceptual_hashes(out_path)
    img = Image(
        project_id=project.id,
        file_path=str(out_path),
        file_name=out_path.name,
        file_hash=file_hash,
        phash=json.dumps(phash_dict) if phash_dict else None,
        width=width,
        height=height,
        file_size_kb=len(labeled) // 1024,
        quality_status="passed",
        tag_status="pending",
        source_type="generated",
        relative_dir=f"uploads/generated/{today}",
        parent_id=parent_id,
        generation_metadata={
            "type": gtype,
            "prompt": prompt_for_meta[:500],  # cap to avoid bloating JSON
            "seed": cand.seed,
            "cost_usd": cand.cost_usd,
            "generated_at": datetime.utcnow().isoformat(),
        },
    )
    db.add(img)
    return img


@router.post("")
async def generate(
    body: GenerateRequest,
    db: AsyncSession = Depends(get_db),
):
    """POST /api/generate — see module docstring for shape."""
    if body.type not in VALID_TYPES:
        raise HTTPException(400, {"code": "invalid_type",
                                  "message": f"unknown type {body.type!r}"})

    project = (await db.execute(
        select(Project).where(Project.id == body.project_id)
    )).scalar_one_or_none()
    if not project:
        raise HTTPException(404, {"code": "project_not_found",
                                  "message": "project_id 不存在或无权访问"})

    # Resolve input image path (if any) — img2img / outpaint / inpaint /
    # matting / eraser / upscale / text-zh / edit all need an input image.
    input_path: str | None = None
    parent_id: str | None = None
    if body.input_image_id:
        src = await db.get(Image, body.input_image_id)
        if not src:
            raise HTTPException(404, {"code": "input_image_not_found",
                                      "message": f"image {body.input_image_id} 不存在"})
        if src.project_id != project.id:
            raise HTTPException(403, {"code": "cross_project",
                                      "message": "不能引用其他项目的图"})
        input_path = src.file_path
        parent_id = src.id

    # Phase 1: ignore mask / style_archive_id / strength / consistency / speed
    # — they're accepted in the contract but the underlying image2 model
    # doesn't expose all of them. PR-7 will wire style_archive_id through.

    mask_bytes = _decode_mask(body.mask)

    try:
        candidates = await dispatch(
            gtype=body.type,
            prompt=body.prompt,
            instruction=body.instruction,
            input_image_path=input_path,
            target_w=body.target_w,
            target_h=body.target_h,
            model_id=body.model_id,
            count=body.count,
            mask_bytes=mask_bytes,
            align_x=body.align_x,
            align_y=body.align_y,
            style_archive_id=body.style_archive_id,
        )
    except GenerationFailure as gf:
        # Friendly structured response; canvas UI converts the code → toast text
        return {"ok": False,
                "error": {"code": gf.code, "message": gf.message}}

    # Persist each candidate so it's immediately a real ImageRecord that
    # the canvas can manipulate (replace / select / inspect) and that
    # shows up in the asset library without a second click.
    prompt_for_meta = body.instruction or body.prompt or ""
    persisted: List[Image] = []
    total_cost = 0.0
    persist_failures: list[str] = []
    for cand in candidates:
        try:
            img = await _persist_candidate(
                db, project, cand,
                gtype=body.type, parent_id=parent_id,
                prompt_for_meta=prompt_for_meta,
            )
            persisted.append(img)
            total_cost += cand.cost_usd
        except GenerationFailure as gf:
            # 单个候选落库失败不再整批丢弃 —— 已生成的候选都已经计费,直接 return
            # 会让前端只看到"全失败",已花钱的图也拿不到。改为跳过坏的、保留好的,
            # 末尾以 partial 标记告知前端。
            logger.warning("persist candidate failed (%d ok so far): %s", len(persisted), gf.message)
            persist_failures.append(gf.message)
            continue

    # 全部候选都没落库成功 → 这才是真失败
    if not persisted:
        msg = persist_failures[0] if persist_failures else "候选生成结果均无法保存"
        return {"ok": False, "error": {"code": "persist_failed", "message": msg}}

    await db.flush()
    ids = [im.id for im in persisted]
    await db.commit()
    for iid in ids:
        try:
            await enqueue_image_sync(iid)
        except Exception as e:
            logger.debug("oss enqueue (generate) failed for %s: %s", iid, e)

    return {
        "ok": True,
        # partial=True 表示有候选生成成功但部分落库失败;前端可据此提示
        # "部分候选保存失败"而不是当成全成功。requested 用于对账。
        "partial": bool(persist_failures),
        "requested": body.count,
        "total_cost_usd": round(total_cost, 6),
        "candidates": [
            {
                "image_id": img.id,
                "url": f"/api/images/{img.id}/file",
                "thumbnail_url": f"/api/images/{img.id}/thumbnail?size=800",
                "w": img.width,
                "h": img.height,
                "seed": (img.generation_metadata or {}).get("seed"),
                "quality": body.speed or "refined",
            }
            for img in persisted
        ],
    }
