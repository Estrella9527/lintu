"""Style transfer engine: AI generation with PIL fallback."""

import json
import logging

import numpy as np
from PIL import Image as PILImage, ImageEnhance, ImageFilter
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.engines.generation_pipeline import pipeline
from sidecar.engines.generation_utils import get_prompt_template, save_generated_image
from sidecar.engines.image_utils import effective_file_path
from sidecar.providers.base import ProviderError

logger = logging.getLogger(__name__)

DEFAULT_PROMPT = "将这张景区照片转换为{style}艺术风格。保持画面构图和主体内容不变，只改变渲染风格。输出高质量图片。"

# PIL fallback filters
def _watercolor(img): return ImageEnhance.Color(img.filter(ImageFilter.GaussianBlur(2))).enhance(1.5)
def _oil_paint(img): return ImageEnhance.Contrast(ImageEnhance.Color(img.filter(ImageFilter.SMOOTH_MORE)).enhance(1.4)).enhance(1.2)
def _sketch(img):
    gray = img.convert("L")
    inv = PILImage.eval(gray, lambda x: 255 - x)
    blur = inv.filter(ImageFilter.GaussianBlur(21))
    s = np.clip(np.array(gray, dtype=np.float64) / (256 - np.array(blur, dtype=np.float64) + 1) * 256, 0, 255)
    return PILImage.fromarray(s.astype(np.uint8)).convert("RGB")
def _vintage(img):
    sepia = np.dot(np.array(img, dtype=np.float64)[..., :3], [[.393,.769,.189],[.349,.686,.168],[.272,.534,.131]])
    return ImageEnhance.Contrast(PILImage.fromarray(np.clip(sepia, 0, 255).astype(np.uint8))).enhance(0.9)
def _high_contrast(img): return ImageEnhance.Sharpness(ImageEnhance.Color(ImageEnhance.Contrast(img).enhance(1.6)).enhance(1.2)).enhance(1.3)
def _soft_focus(img): return PILImage.blend(img, img.filter(ImageFilter.GaussianBlur(3)), 0.5)

STYLES = {"水彩": _watercolor, "油画": _oil_paint, "素描": _sketch, "复古": _vintage, "高对比": _high_contrast, "柔焦": _soft_focus}


async def run_style(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    style_name = params.get("style", "水彩")
    image_ids = params.get("image_ids", [])

    prompt = get_prompt_template("style", DEFAULT_PROMPT, style=style_name)
    allow_pil_fallback = bool(params.get("allow_pil_fallback", True))
    output_dir = WORKSPACE_DIR / "generated" / "style"
    output_dir.mkdir(parents=True, exist_ok=True)

    style_fn = STYLES.get(style_name, _watercolor)

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
            out_path = output_dir / f"{img_record.id}_{style_name}.jpg"
            try:
                src_path = effective_file_path(img_record)
                gen = await pipeline.execute(src_path, prompt)
                save_generated_image(gen.image_data, out_path)
            except (ProviderError, Exception) as e:
                if not allow_pil_fallback:
                    logger.error("style failed for %s (no PIL fallback): %s", img_record.id, e)
                    raise
                src = PILImage.open(effective_file_path(img_record)).convert("RGB")
                styled = style_fn(src)
                if styled.mode != "RGB":
                    styled = styled.convert("RGB")
                styled.save(str(out_path), "JPEG", quality=90)

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
        logger.info(f"Style done: {total} images → {style_name}")
