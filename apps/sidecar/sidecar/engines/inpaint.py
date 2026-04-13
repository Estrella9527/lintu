"""Inpaint engine: remove/replace elements in images (local implementation)."""

import json
import logging
from pathlib import Path

import numpy as np
from PIL import Image as PILImage, ImageDraw, ImageFilter
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)

EDIT_TYPES = {
    "去水印": {"position": "bottom-right", "size_ratio": 0.15},
    "去人物": {"method": "blur_region"},
    "换天空": {"method": "sky_replace"},
    "去文字": {"position": "auto", "size_ratio": 0.1},
}


def _remove_watermark(img: PILImage.Image, position: str, size_ratio: float) -> PILImage.Image:
    """Remove watermark by blurring a corner region."""
    w, h = img.size
    region_w = int(w * size_ratio)
    region_h = int(h * size_ratio)

    if position == "bottom-right":
        box = (w - region_w, h - region_h, w, h)
    elif position == "bottom-left":
        box = (0, h - region_h, region_w, h)
    elif position == "top-right":
        box = (w - region_w, 0, w, region_h)
    else:
        box = (0, 0, region_w, region_h)

    result = img.copy()
    region = result.crop(box)
    # Inpaint by heavy blur + surrounding color blend
    blurred = region.filter(ImageFilter.GaussianBlur(radius=15))
    result.paste(blurred, box)
    return result


def _blur_region_center(img: PILImage.Image) -> PILImage.Image:
    """Blur the center region (simple person removal approximation)."""
    w, h = img.size
    margin_x = int(w * 0.25)
    margin_y = int(h * 0.2)
    box = (margin_x, margin_y, w - margin_x, h - margin_y)

    result = img.copy()
    region = result.crop(box)
    blurred = region.filter(ImageFilter.GaussianBlur(radius=20))
    result.paste(blurred, box)
    return result


def _replace_sky(img: PILImage.Image) -> PILImage.Image:
    """Simple sky replacement: replace top 30% with gradient."""
    w, h = img.size
    sky_h = int(h * 0.3)

    arr = np.array(img)
    # Create blue sky gradient
    for y in range(sky_h):
        ratio = y / sky_h
        r = int(135 + (200 - 135) * ratio)
        g = int(206 + (220 - 206) * ratio)
        b = int(235 + (240 - 235) * ratio)
        arr[y, :] = [r, g, b]

    # Blend boundary
    blend_h = min(30, sky_h // 3)
    for y in range(blend_h):
        alpha = y / blend_h
        orig = np.array(img)[sky_h - blend_h + y]
        arr[sky_h - blend_h + y] = (arr[sky_h - blend_h + y] * (1 - alpha) + orig * alpha).astype(np.uint8)

    return PILImage.fromarray(arr)


async def run_inpaint(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    edit_type = params.get("edit_type", "去水印")
    image_ids = params.get("image_ids", [])

    output_dir = WORKSPACE_DIR / "generated" / "inpaint"
    output_dir.mkdir(parents=True, exist_ok=True)

    async with async_session() as db:
        if image_ids:
            result = await db.execute(select(Image).where(Image.id.in_(image_ids)))
        else:
            result = await db.execute(
                select(Image).where(Image.project_id == task.project_id, Image.quality_status == "passed", Image.is_kept == True)
            )
        images = result.scalars().all()
        total = len(images)
        await progress_cb(total=total, processed=0)

        for idx, img_record in enumerate(images):
            try:
                src = PILImage.open(img_record.file_path)
                if src.mode != "RGB":
                    src = src.convert("RGB")

                if edit_type == "去水印" or edit_type == "去文字":
                    cfg = EDIT_TYPES.get(edit_type, EDIT_TYPES["去水印"])
                    edited = _remove_watermark(src, cfg.get("position", "bottom-right"), cfg.get("size_ratio", 0.15))
                elif edit_type == "去人物":
                    edited = _blur_region_center(src)
                elif edit_type == "换天空":
                    edited = _replace_sky(src)
                else:
                    edited = src

                out_path = output_dir / f"{img_record.id}_{edit_type}.jpg"
                edited.save(str(out_path), "JPEG", quality=90)

                db.add(Image(
                    project_id=task.project_id, file_path=str(out_path), file_name=out_path.name,
                    width=edited.size[0], height=edited.size[1], file_size_kb=out_path.stat().st_size // 1024,
                    quality_status="passed", tag_status="pending", source_type="generated", parent_id=img_record.id,
                ))
            except Exception as e:
                logger.error(f"Inpaint failed for {img_record.id}: {e}")

            if (idx + 1) % 5 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total)

        await db.commit()
        logger.info(f"Inpaint done: {total} images, type={edit_type}")
