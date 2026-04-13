"""Style transfer engine: apply artistic style filters."""

import json
import logging
from pathlib import Path

import numpy as np
from PIL import Image as PILImage, ImageEnhance, ImageFilter
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)

STYLES = {
    "水彩": lambda img: _watercolor(img),
    "油画": lambda img: _oil_paint(img),
    "素描": lambda img: _sketch(img),
    "复古": lambda img: _vintage(img),
    "高对比": lambda img: _high_contrast(img),
    "柔焦": lambda img: _soft_focus(img),
}


def _watercolor(img: PILImage.Image) -> PILImage.Image:
    blurred = img.filter(ImageFilter.GaussianBlur(radius=2))
    enhanced = ImageEnhance.Color(blurred).enhance(1.5)
    return ImageEnhance.Contrast(enhanced).enhance(0.8)


def _oil_paint(img: PILImage.Image) -> PILImage.Image:
    result = img.filter(ImageFilter.SMOOTH_MORE)
    result = ImageEnhance.Color(result).enhance(1.4)
    return ImageEnhance.Contrast(result).enhance(1.2)


def _sketch(img: PILImage.Image) -> PILImage.Image:
    gray = img.convert("L")
    inverted = PILImage.eval(gray, lambda x: 255 - x)
    blurred = inverted.filter(ImageFilter.GaussianBlur(radius=21))
    arr_gray = np.array(gray, dtype=np.float64)
    arr_blur = np.array(blurred, dtype=np.float64)
    sketch = np.clip(arr_gray / (256 - arr_blur + 1) * 256, 0, 255).astype(np.uint8)
    return PILImage.fromarray(sketch).convert("RGB")


def _vintage(img: PILImage.Image) -> PILImage.Image:
    arr = np.array(img, dtype=np.float64)
    # Sepia tone
    sepia = np.dot(arr[..., :3], [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]])
    sepia = np.clip(sepia, 0, 255).astype(np.uint8)
    result = PILImage.fromarray(sepia)
    return ImageEnhance.Contrast(result).enhance(0.9)


def _high_contrast(img: PILImage.Image) -> PILImage.Image:
    result = ImageEnhance.Contrast(img).enhance(1.6)
    result = ImageEnhance.Color(result).enhance(1.2)
    return ImageEnhance.Sharpness(result).enhance(1.3)


def _soft_focus(img: PILImage.Image) -> PILImage.Image:
    blurred = img.filter(ImageFilter.GaussianBlur(radius=3))
    return PILImage.blend(img, blurred, alpha=0.5)


async def run_style(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    style_name = params.get("style", "水彩")
    image_ids = params.get("image_ids", [])
    style_fn = STYLES.get(style_name)
    if not style_fn:
        raise ValueError(f"未知风格: {style_name}, 可选: {list(STYLES.keys())}")

    output_dir = WORKSPACE_DIR / "generated" / "style"
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
                styled = style_fn(src)
                out_path = output_dir / f"{img_record.id}_{style_name}.jpg"
                styled.save(str(out_path), "JPEG", quality=90)

                db.add(Image(
                    project_id=task.project_id, file_path=str(out_path), file_name=out_path.name,
                    width=styled.size[0], height=styled.size[1], file_size_kb=out_path.stat().st_size // 1024,
                    quality_status="passed", tag_status="pending", source_type="generated", parent_id=img_record.id,
                ))
            except Exception as e:
                logger.error(f"Style failed for {img_record.id}: {e}")

            if (idx + 1) % 5 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total)

        await db.commit()
        logger.info(f"Style done: {total} images → {style_name}")
