"""Quality check engine: blur detection, resolution check, brightness check."""

import json
import logging
from pathlib import Path

from PIL import Image as PILImage
import numpy as np
from sqlalchemy import select, update

from sidecar.db.models import Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)


def _check_image(path: str, min_resolution: int, blur_threshold: float,
                 brightness_min: float, brightness_max: float) -> dict:
    """Run quality checks on a single image. Returns result dict."""
    try:
        img = PILImage.open(path)
    except Exception as e:
        return {"passed": False, "reason": "file_corrupt", "blur_score": 0, "brightness": 0}

    w, h = img.size

    # Resolution check
    if min(w, h) < min_resolution:
        return {"passed": False, "reason": f"low_resolution ({w}x{h})",
                "blur_score": 0, "brightness": 0}

    # Convert to grayscale numpy for analysis
    gray = np.array(img.convert("L"), dtype=np.float64)

    # Blur detection via Laplacian variance
    # Higher = sharper, lower = blurrier
    laplacian = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float64)
    from scipy.signal import convolve2d
    lap = convolve2d(gray, laplacian, mode="valid")
    blur_score = float(lap.var())

    # Brightness (mean pixel value 0-255)
    brightness = float(gray.mean())

    if blur_score < blur_threshold:
        return {"passed": False, "reason": "blurry", "blur_score": blur_score, "brightness": brightness}

    if brightness < brightness_min:
        return {"passed": False, "reason": "too_dark", "blur_score": blur_score, "brightness": brightness}

    if brightness > brightness_max:
        return {"passed": False, "reason": "overexposed", "blur_score": blur_score, "brightness": brightness}

    return {"passed": True, "reason": None, "blur_score": blur_score, "brightness": brightness}


async def run_quality_check(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    min_resolution = params.get("min_resolution", 720)
    blur_threshold = params.get("blur_threshold", 80)
    brightness_min = params.get("brightness_min", 30)
    brightness_max = params.get("brightness_max", 225)

    async with async_session() as db:
        # Get all pending images for this project
        result = await db.execute(
            select(Image)
            .where(Image.project_id == task.project_id)
            .where(Image.quality_status == "pending")
        )
        images = result.scalars().all()

        total = len(images)
        await progress_cb(total=total, processed=0, passed_count=0, failed_count=0)

        passed_count = 0
        failed_count = 0

        for idx, img in enumerate(images):
            result = _check_image(
                img.file_path, min_resolution, blur_threshold,
                brightness_min, brightness_max,
            )

            await db.execute(
                update(Image).where(Image.id == img.id).values(
                    blur_score=result["blur_score"],
                    brightness=result["brightness"],
                    quality_status="passed" if result["passed"] else "rejected",
                    reject_reason=result["reason"],
                )
            )

            if result["passed"]:
                passed_count += 1
            else:
                failed_count += 1

            # Push progress every 10 images or at the end
            if (idx + 1) % 10 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(
                    processed=idx + 1,
                    total=total,
                    passed_count=passed_count,
                    failed_count=failed_count,
                )

        await db.commit()
        logger.info(f"Quality check done: {passed_count} passed, {failed_count} rejected")
