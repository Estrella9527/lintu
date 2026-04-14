"""Seasonal variation engine: AI generation with PIL fallback."""

import json
import logging
from pathlib import Path

import numpy as np
from PIL import Image as PILImage, ImageEnhance
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.engines.generation_utils import get_generation_provider, get_prompt_template, save_generated_image

logger = logging.getLogger(__name__)

DEFAULT_PROMPT = "将这张景区风景照片变换为{season}场景。保持画面中的建筑、道路、设施等主体结构完全不变，只改变植被、天空、光线等自然元素以体现{season}特征。输出高质量照片级真实感图片。"


def _apply_season_filter(img: PILImage.Image, season: str) -> PILImage.Image:
    arr = np.array(img, dtype=np.float64)
    if season == "春季":
        arr[:, :, 1] = np.clip(arr[:, :, 1] * 1.15, 0, 255)
        arr[:, :, 0] = np.clip(arr[:, :, 0] * 1.05, 0, 255)
        result = PILImage.fromarray(arr.astype(np.uint8))
        result = ImageEnhance.Color(result).enhance(1.2)
        result = ImageEnhance.Brightness(result).enhance(1.05)
    elif season == "夏季":
        arr[:, :, 1] = np.clip(arr[:, :, 1] * 1.2, 0, 255)
        result = PILImage.fromarray(arr.astype(np.uint8))
        result = ImageEnhance.Color(result).enhance(1.3)
        result = ImageEnhance.Brightness(result).enhance(1.08)
    elif season == "秋季":
        arr[:, :, 0] = np.clip(arr[:, :, 0] * 1.2, 0, 255)
        arr[:, :, 1] = np.clip(arr[:, :, 1] * 0.9, 0, 255)
        arr[:, :, 2] = np.clip(arr[:, :, 2] * 0.85, 0, 255)
        result = PILImage.fromarray(arr.astype(np.uint8))
        result = ImageEnhance.Color(result).enhance(1.25)
    elif season == "冬季":
        arr[:, :, 2] = np.clip(arr[:, :, 2] * 1.15, 0, 255)
        arr[:, :, 0] = np.clip(arr[:, :, 0] * 0.95, 0, 255)
        result = PILImage.fromarray(arr.astype(np.uint8))
        result = ImageEnhance.Color(result).enhance(0.7)
        result = ImageEnhance.Brightness(result).enhance(1.1)
    else:
        result = img
    return result


async def run_seasonal(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    target_season = params.get("season", "秋季")
    image_ids = params.get("image_ids", [])

    prompt = get_prompt_template("seasonal", DEFAULT_PROMPT, season=target_season)
    output_dir = WORKSPACE_DIR / "generated" / "seasonal"
    output_dir.mkdir(parents=True, exist_ok=True)

    provider = None
    try:
        provider = get_generation_provider()
    except Exception as e:
        logger.info(f"No AI provider, using PIL fallback: {e}")

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
            season_label = target_season.replace("季", "")
            out_path = output_dir / f"{img_record.id}_{season_label}.jpg"

            try:
                if provider:
                    gen = await provider.generate_image(img_record.file_path, prompt)
                    save_generated_image(gen["image_data"], out_path)
                else:
                    raise NotImplementedError
            except Exception as e:
                logger.info(f"PIL fallback for {img_record.id}: {e}")
                src = PILImage.open(img_record.file_path).convert("RGB")
                _apply_season_filter(src, target_season).save(str(out_path), "JPEG", quality=90)

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
        logger.info(f"Seasonal done: {total} images → {target_season}")
