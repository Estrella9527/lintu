"""Outpaint engine: AI canvas extension with PIL fallback."""

import json
import logging

import numpy as np
from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.engines.generation_pipeline import pipeline
from sidecar.engines.generation_utils import get_prompt_template, save_generated_image
from sidecar.engines.image_utils import effective_file_path
from sidecar.providers.base import ProviderError

logger = logging.getLogger(__name__)

DEFAULT_PROMPT = "将这张景区照片扩展为{ratio}比例。自然补全画面边缘的内容，保持风格、光线和透视一致。输出高质量照片级真实感图片。"

RATIO_SIZES = {"16:9": (1920, 1080), "9:16": (1080, 1920), "4:3": (1600, 1200), "3:4": (1200, 1600), "1:1": (1440, 1440)}


def _extend_canvas_pil(img: PILImage.Image, target_w: int, target_h: int) -> PILImage.Image:
    """PIL fallback: place original centered and stretch edge pixels."""
    src_w, src_h = img.size
    scale = min(target_w / src_w, target_h / src_h)
    new_w, new_h = int(src_w * scale), int(src_h * scale)
    resized = img.resize((new_w, new_h), PILImage.Resampling.LANCZOS)
    canvas = PILImage.new("RGB", (target_w, target_h), (128, 128, 128))
    x_off, y_off = (target_w - new_w) // 2, (target_h - new_h) // 2
    canvas.paste(resized, (x_off, y_off))

    arr = np.array(canvas)
    src_arr = np.array(resized)
    if y_off > 0:
        arr[0:y_off, x_off:x_off+new_w] = np.broadcast_to(src_arr[0:1], (y_off, new_w, 3))
    if y_off + new_h < target_h:
        arr[y_off+new_h:, x_off:x_off+new_w] = np.broadcast_to(src_arr[-1:], (target_h-y_off-new_h, new_w, 3))
    if x_off > 0:
        arr[y_off:y_off+new_h, 0:x_off] = np.broadcast_to(arr[y_off:y_off+new_h, x_off:x_off+1], (new_h, x_off, 3))
    if x_off + new_w < target_w:
        arr[y_off:y_off+new_h, x_off+new_w:] = np.broadcast_to(arr[y_off:y_off+new_h, x_off+new_w-1:x_off+new_w], (new_h, target_w-x_off-new_w, 3))
    return PILImage.fromarray(arr)


async def run_outpaint(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    ratio = params.get("ratio", "16:9")
    image_ids = params.get("image_ids", [])
    target_w, target_h = RATIO_SIZES.get(ratio, (1920, 1080))

    prompt = get_prompt_template("outpaint", DEFAULT_PROMPT, ratio=ratio)
    allow_pil_fallback = bool(params.get("allow_pil_fallback", True))
    output_dir = WORKSPACE_DIR / "generated" / "outpaint"
    output_dir.mkdir(parents=True, exist_ok=True)

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
            out_path = output_dir / f"{img_record.id}_outpaint_{ratio.replace(':', 'x')}.jpg"
            try:
                src_path = effective_file_path(img_record)
                gen = await pipeline.execute(src_path, prompt)
                save_generated_image(gen.image_data, out_path)
            except (ProviderError, Exception) as e:
                if not allow_pil_fallback:
                    logger.error("outpaint failed for %s (no PIL fallback): %s", img_record.id, e)
                    raise
                src = PILImage.open(effective_file_path(img_record)).convert("RGB")
                _extend_canvas_pil(src, target_w, target_h).save(str(out_path), "JPEG", quality=90)

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
        logger.info(f"Outpaint done: {total} images to {ratio}")
