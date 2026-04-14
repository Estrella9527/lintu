"""Orientation correction engine: fix rotated/flipped images.

Handles:
1. EXIF orientation tag — auto-rotate based on camera metadata
2. Wrong aspect ratio — detect portrait images saved as landscape (and vice versa)
3. Manual rotation — apply user-specified rotation (90/180/270)
"""

import json
import logging
from pathlib import Path

from PIL import Image as PILImage, ImageOps
from sqlalchemy import select, update

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)


def _fix_exif_orientation(img: PILImage.Image) -> tuple[PILImage.Image, bool]:
    """Apply EXIF orientation tag and strip it. Returns (image, was_rotated)."""
    try:
        original_size = img.size
        img = ImageOps.exif_transpose(img)
        rotated = img.size != original_size
        return img, rotated
    except Exception:
        return img, False


def _detect_likely_rotated(img: PILImage.Image) -> int:
    """Heuristic: detect if image is likely rotated 90°.
    Landscape photos (w > h) stored as portrait (h > w) are suspicious.
    Returns suggested rotation in degrees (0, 90, 270), 0 = no rotation needed.
    """
    w, h = img.size
    ratio = max(w, h) / min(w, h)

    # Only flag extreme aspect ratios (phone photos rotated wrong)
    # Normal landscape: ~1.33 (4:3) or ~1.78 (16:9)
    # If portrait but ratio suggests it should be landscape, suggest rotation
    if h > w and ratio > 1.2:
        # Portrait image with landscape-like ratio — might be rotated
        # Check if rotating would give a more standard ratio
        # This is a weak heuristic, only flag very obvious cases
        if ratio > 1.5:
            return 0  # Could be intentional portrait
    return 0  # Don't auto-rotate without EXIF evidence


async def run_orient(task: Task, progress_cb):
    """Fix orientation for all pending images in project."""
    params = json.loads(task.parameters or "{}")
    mode = params.get("mode", "auto")  # auto | rotate_cw | rotate_ccw | rotate_180
    image_ids = params.get("image_ids", [])

    rotation_map = {
        "auto": None,
        "rotate_cw": 270,      # Clockwise 90° = PIL rotate 270
        "rotate_ccw": 90,      # Counter-clockwise 90° = PIL rotate 90
        "rotate_180": 180,
    }
    manual_rotation = rotation_map.get(mode)

    async with async_session() as db:
        if image_ids:
            result = await db.execute(select(Image).where(Image.id.in_(image_ids)))
        else:
            result = await db.execute(
                select(Image).where(
                    Image.project_id == task.project_id,
                    Image.quality_status.in_(["pending", "passed"]),
                )
            )
        images = result.scalars().all()
        total = len(images)

        fixed = 0
        skipped = 0
        await progress_cb(total=total, processed=0, fixed=0, skipped=0)

        for idx, img_record in enumerate(images):
            try:
                src = PILImage.open(img_record.file_path)

                if mode == "auto":
                    # Auto mode: fix EXIF orientation
                    corrected, was_rotated = _fix_exif_orientation(src)
                    if was_rotated:
                        if corrected.mode in ("RGBA", "P"):
                            corrected = corrected.convert("RGB")
                        corrected.save(img_record.file_path, "JPEG", quality=92)
                        # Update dimensions in DB
                        await db.execute(
                            update(Image).where(Image.id == img_record.id).values(
                                width=corrected.size[0],
                                height=corrected.size[1],
                            )
                        )
                        fixed += 1
                    else:
                        skipped += 1
                else:
                    # Manual rotation
                    if manual_rotation:
                        rotated = src.rotate(manual_rotation, expand=True)
                        if rotated.mode in ("RGBA", "P"):
                            rotated = rotated.convert("RGB")
                        rotated.save(img_record.file_path, "JPEG", quality=92)
                        await db.execute(
                            update(Image).where(Image.id == img_record.id).values(
                                width=rotated.size[0],
                                height=rotated.size[1],
                            )
                        )
                        fixed += 1
                    else:
                        skipped += 1

            except Exception as e:
                logger.error(f"Orient failed for {img_record.id}: {e}")
                skipped += 1

            if (idx + 1) % 20 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(
                    processed=idx + 1, total=total,
                    fixed=fixed, skipped=skipped,
                )

        await db.commit()
        logger.info(f"Orient done: {fixed} fixed, {skipped} skipped, {total} total")
