"""Inpaint engine: AI element removal/editing with PIL fallback."""

import json
import logging

import numpy as np
from PIL import Image as PILImage, ImageFilter
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.engines.generation_pipeline import pipeline
from sidecar.engines.generation_utils import get_prompt_template, save_generated_image
from sidecar.engines.image_utils import effective_file_path
from sidecar.providers.base import ProviderError

logger = logging.getLogger(__name__)

EDIT_PROMPTS = {
    "去水印": "Remove all watermarks and logos from this image. Fill the removed areas naturally to match the surrounding environment. Output a clean photo.",
    "去人物": "Remove all people and pedestrians from this scenic landscape photo. Fill the removed areas naturally with the surrounding environment. Output a clean photo.",
    "换天空": "Replace the sky in this landscape photo with a beautiful clear blue sky with light clouds. Keep the ground, buildings, and all other elements unchanged. Output a photorealistic image.",
    "去文字": "Remove all text, signs, and written content from this image. Fill the removed areas naturally. Output a clean photo.",
}

DEFAULT_PROMPT = "{edit_prompt}"


def _remove_watermark_pil(img, pos="bottom-right", ratio=0.15):
    w, h = img.size
    rw, rh = int(w * ratio), int(h * ratio)
    boxes = {"bottom-right": (w-rw, h-rh, w, h), "bottom-left": (0, h-rh, rw, h),
             "top-right": (w-rw, 0, w, rh), "top-left": (0, 0, rw, rh)}
    box = boxes.get(pos, boxes["bottom-right"])
    result = img.copy()
    result.paste(result.crop(box).filter(ImageFilter.GaussianBlur(15)), box)
    return result

def _blur_center_pil(img):
    w, h = img.size
    mx, my = int(w * 0.25), int(h * 0.2)
    box = (mx, my, w - mx, h - my)
    result = img.copy()
    result.paste(result.crop(box).filter(ImageFilter.GaussianBlur(20)), box)
    return result

def _replace_sky_pil(img):
    w, h = img.size
    sky_h = int(h * 0.3)
    arr = np.array(img)
    for y in range(sky_h):
        r = y / sky_h
        arr[y] = [int(135 + 65 * r), int(206 + 14 * r), int(235 + 5 * r)]
    blend_h = min(30, sky_h // 3)
    orig = np.array(img)
    for y in range(blend_h):
        a = y / blend_h
        arr[sky_h - blend_h + y] = (arr[sky_h - blend_h + y] * (1 - a) + orig[sky_h - blend_h + y] * a).astype(np.uint8)
    return PILImage.fromarray(arr)

PIL_FALLBACKS = {
    "去水印": lambda img: _remove_watermark_pil(img),
    "去人物": lambda img: _blur_center_pil(img),
    "换天空": lambda img: _replace_sky_pil(img),
    "去文字": lambda img: _remove_watermark_pil(img, "top-left", 0.1),
}


async def run_inpaint(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    edit_type = params.get("edit_type", "去水印")
    image_ids = params.get("image_ids", [])

    edit_prompt = EDIT_PROMPTS.get(edit_type, EDIT_PROMPTS["去水印"])
    prompt = get_prompt_template("inpaint", DEFAULT_PROMPT, edit_prompt=edit_prompt)
    allow_pil_fallback = bool(params.get("allow_pil_fallback", True))
    output_dir = WORKSPACE_DIR / "generated" / "inpaint"
    output_dir.mkdir(parents=True, exist_ok=True)

    pil_fn = PIL_FALLBACKS.get(edit_type, PIL_FALLBACKS["去水印"])

    async with async_session() as db:
        if image_ids:
            result = await db.execute(select(Image).where(Image.id.in_(image_ids)))
        else:
            result = await db.execute(select(Image).where(
                Image.project_id == task.project_id, Image.quality_status == "passed", Image.is_kept == True))
        images = result.scalars().all()
        total = len(images)
        await progress_cb(total=total, processed=0)

        for idx, img_record in enumerate(images):
            out_path = output_dir / f"{img_record.id}_{edit_type}.jpg"
            try:
                src_path = effective_file_path(img_record)
                gen = await pipeline.execute(src_path, prompt)
                save_generated_image(gen.image_data, out_path)
            except (ProviderError, Exception) as e:
                if not allow_pil_fallback:
                    logger.error("inpaint failed for %s (no PIL fallback): %s", img_record.id, e)
                    raise
                src = PILImage.open(effective_file_path(img_record)).convert("RGB")
                edited = pil_fn(src)
                if edited.mode != "RGB":
                    edited = edited.convert("RGB")
                edited.save(str(out_path), "JPEG", quality=90)

            w, h = PILImage.open(str(out_path)).size
            db.add(Image(
                project_id=task.project_id, file_path=str(out_path), file_name=out_path.name,
                width=w, height=h, file_size_kb=out_path.stat().st_size // 1024,
                quality_status="passed", tag_status="pending", source_type="generated", parent_id=img_record.id,
            ))
            if (idx + 1) % 5 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total)

        await db.commit()
        logger.info(f"Inpaint done: {total} images, type={edit_type}")
