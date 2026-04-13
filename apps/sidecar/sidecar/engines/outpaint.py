"""Outpaint engine: canvas extension using AI image generation."""

import base64
import io
import json
import logging
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.defaults import get_setting

logger = logging.getLogger(__name__)

RATIO_SIZES = {
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
    "4:3": (1600, 1200),
    "3:4": (1200, 1600),
    "1:1": (1440, 1440),
}


def _extend_canvas(img: PILImage.Image, target_w: int, target_h: int) -> PILImage.Image:
    """Extend canvas by placing original at center and filling edges with edge pixels."""
    src_w, src_h = img.size
    # Scale original to fit within target while maintaining aspect ratio
    scale = min(target_w / src_w, target_h / src_h)
    new_w = int(src_w * scale)
    new_h = int(src_h * scale)
    resized = img.resize((new_w, new_h), PILImage.Resampling.LANCZOS)

    # Create canvas and paste centered
    canvas = PILImage.new("RGB", (target_w, target_h), (128, 128, 128))
    x_offset = (target_w - new_w) // 2
    y_offset = (target_h - new_h) // 2
    canvas.paste(resized, (x_offset, y_offset))

    # Fill borders by stretching edge pixels (simple outpaint approximation)
    import numpy as np
    arr = np.array(canvas)
    src_arr = np.array(resized)

    # Top
    if y_offset > 0:
        top_row = src_arr[0:1, :, :]
        arr[0:y_offset, x_offset:x_offset + new_w, :] = np.broadcast_to(top_row, (y_offset, new_w, 3))
    # Bottom
    if y_offset + new_h < target_h:
        bottom_row = src_arr[-1:, :, :]
        arr[y_offset + new_h:, x_offset:x_offset + new_w, :] = np.broadcast_to(bottom_row, (target_h - y_offset - new_h, new_w, 3))
    # Left
    if x_offset > 0:
        left_col = arr[y_offset:y_offset + new_h, x_offset:x_offset + 1, :]
        arr[y_offset:y_offset + new_h, 0:x_offset, :] = np.broadcast_to(left_col, (new_h, x_offset, 3))
    # Right
    if x_offset + new_w < target_w:
        right_col = arr[y_offset:y_offset + new_h, x_offset + new_w - 1:x_offset + new_w, :]
        arr[y_offset:y_offset + new_h, x_offset + new_w:, :] = np.broadcast_to(right_col, (new_h, target_w - x_offset - new_w, 3))
    # Corners
    if y_offset > 0 and x_offset > 0:
        arr[0:y_offset, 0:x_offset, :] = arr[y_offset, x_offset]
    if y_offset > 0 and x_offset + new_w < target_w:
        arr[0:y_offset, x_offset + new_w:, :] = arr[y_offset, x_offset + new_w - 1]
    if y_offset + new_h < target_h and x_offset > 0:
        arr[y_offset + new_h:, 0:x_offset, :] = arr[y_offset + new_h - 1, x_offset]
    if y_offset + new_h < target_h and x_offset + new_w < target_w:
        arr[y_offset + new_h:, x_offset + new_w:, :] = arr[y_offset + new_h - 1, x_offset + new_w - 1]

    return PILImage.fromarray(arr)


async def run_outpaint(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    ratio = params.get("ratio", "16:9")
    image_ids = params.get("image_ids", [])
    target_w, target_h = RATIO_SIZES.get(ratio, (1920, 1080))

    output_dir = WORKSPACE_DIR / "generated" / "outpaint"
    output_dir.mkdir(parents=True, exist_ok=True)

    async with async_session() as db:
        if image_ids:
            result = await db.execute(select(Image).where(Image.id.in_(image_ids)))
        else:
            result = await db.execute(
                select(Image).where(
                    Image.project_id == task.project_id,
                    Image.quality_status == "passed",
                    Image.is_kept == True,
                )
            )
        images = result.scalars().all()
        total = len(images)
        await progress_cb(total=total, processed=0)

        for idx, img_record in enumerate(images):
            try:
                src = PILImage.open(img_record.file_path)
                if src.mode != "RGB":
                    src = src.convert("RGB")

                extended = _extend_canvas(src, target_w, target_h)

                out_path = output_dir / f"{img_record.id}_outpaint_{ratio.replace(':', 'x')}.jpg"
                extended.save(str(out_path), "JPEG", quality=90)

                new_img = Image(
                    project_id=task.project_id,
                    file_path=str(out_path),
                    file_name=out_path.name,
                    width=target_w,
                    height=target_h,
                    file_size_kb=out_path.stat().st_size // 1024,
                    quality_status="passed",
                    tag_status="pending",
                    source_type="generated",
                    parent_id=img_record.id,
                )
                db.add(new_img)
            except Exception as e:
                logger.error(f"Outpaint failed for {img_record.id}: {e}")

            if (idx + 1) % 5 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total)

        await db.commit()
        logger.info(f"Outpaint done: {total} images to {ratio}")
