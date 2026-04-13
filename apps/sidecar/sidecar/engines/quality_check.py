"""Quality check engine: blur, resolution, brightness, file size checks."""

import json
import logging
from pathlib import Path

import numpy as np
from PIL import Image as PILImage
from scipy.signal import convolve2d
from sqlalchemy import select, update

from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.defaults import get_setting

logger = logging.getLogger(__name__)

# Register HEIC support if available
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    logger.info("HEIC support enabled")
except ImportError:
    pass


def _check_image(path: str, min_resolution: int, blur_threshold: float,
                 brightness_min: float, brightness_max: float,
                 min_file_size_kb: int) -> dict:
    fpath = Path(path)

    # File size check
    try:
        size_kb = fpath.stat().st_size // 1024
        if size_kb < min_file_size_kb:
            return {"passed": False, "reason": f"file_too_small ({size_kb}KB < {min_file_size_kb}KB)",
                    "blur_score": 0, "brightness": 0}
    except OSError:
        return {"passed": False, "reason": "file_corrupt", "blur_score": 0, "brightness": 0}

    # Open image
    try:
        img = PILImage.open(path)
        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")
    except Exception:
        return {"passed": False, "reason": "file_corrupt", "blur_score": 0, "brightness": 0}

    w, h = img.size

    # Resolution check (short side)
    if min(w, h) < min_resolution:
        return {"passed": False, "reason": f"low_resolution ({w}x{h})",
                "blur_score": 0, "brightness": 0}

    # Resize for analysis (cap at 1024px to be fast)
    analysis_img = img.copy()
    analysis_img.thumbnail((1024, 1024))
    gray = np.array(analysis_img.convert("L"), dtype=np.float64)

    # Blur detection: Laplacian variance
    laplacian = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float64)
    lap = convolve2d(gray, laplacian, mode="valid")
    blur_score = float(lap.var())

    # Brightness: mean pixel value
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

    # Read from task params, fall back to global config, then defaults
    min_resolution = params.get("min_resolution", get_setting("quality_min_resolution"))
    blur_threshold = params.get("blur_threshold", get_setting("quality_blur_threshold"))
    brightness_min = params.get("brightness_min", get_setting("quality_brightness_min"))
    brightness_max = params.get("brightness_max", get_setting("quality_brightness_max"))
    min_file_size_kb = params.get("min_file_size_kb", get_setting("quality_min_file_size_kb"))

    async with async_session() as db:
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
            check = _check_image(
                img.file_path, min_resolution, blur_threshold,
                brightness_min, brightness_max, min_file_size_kb,
            )

            await db.execute(
                update(Image).where(Image.id == img.id).values(
                    blur_score=check["blur_score"],
                    brightness=check["brightness"],
                    quality_status="passed" if check["passed"] else "rejected",
                    reject_reason=check["reason"],
                )
            )

            if check["passed"]:
                passed_count += 1
            else:
                failed_count += 1

            if (idx + 1) % 10 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(
                    processed=idx + 1, total=total,
                    passed_count=passed_count, failed_count=failed_count,
                )

        await db.commit()
        logger.info(f"Quality check done: {passed_count} passed, {failed_count} rejected")
