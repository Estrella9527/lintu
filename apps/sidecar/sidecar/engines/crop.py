"""Crop engine: smart center-crop to target aspect ratio."""

import json
import logging
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)

RATIOS = {
    "16:9": (16, 9),
    "9:16": (9, 16),
    "4:3": (4, 3),
    "3:4": (3, 4),
    "1:1": (1, 1),
}


def _crop_to_ratio(img: PILImage.Image, ratio: tuple[int, int]) -> PILImage.Image:
    w, h = img.size
    target_w, target_h = ratio
    target_aspect = target_w / target_h
    current_aspect = w / h

    if current_aspect > target_aspect:
        new_w = int(h * target_aspect)
        left = (w - new_w) // 2
        return img.crop((left, 0, left + new_w, h))
    else:
        new_h = int(w / target_aspect)
        top = (h - new_h) // 2
        return img.crop((0, top, w, top + new_h))


async def run_crop(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    ratio_str = params.get("ratio", "16:9")
    image_ids = params.get("image_ids", [])
    ratio = RATIOS.get(ratio_str, (16, 9))

    output_dir = WORKSPACE_DIR / "generated" / "crop"
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
                cropped = _crop_to_ratio(src, ratio)
                out_path = output_dir / f"{img_record.id}_{ratio_str.replace(':', 'x')}.jpg"
                cropped.save(str(out_path), "JPEG", quality=90)

                # Register as new image
                new_img = Image(
                    project_id=task.project_id,
                    file_path=str(out_path),
                    file_name=out_path.name,
                    width=cropped.size[0],
                    height=cropped.size[1],
                    file_size_kb=out_path.stat().st_size // 1024,
                    quality_status="passed",
                    tag_status="pending",
                    source_type="generated",
                    parent_id=img_record.id,
                )
                db.add(new_img)
            except Exception as e:
                logger.error(f"Crop failed for {img_record.id}: {e}")

            if (idx + 1) % 10 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total)

        await db.commit()
        logger.info(f"Crop done: {total} images processed")
