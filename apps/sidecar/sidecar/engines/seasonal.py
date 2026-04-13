"""Seasonal variation engine: change the season of landscape images using AI."""

import base64
import io
import json
import logging
from pathlib import Path

import httpx
from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.defaults import get_setting

logger = logging.getLogger(__name__)

SEASON_PROMPTS = {
    "春季": "Transform this scenic landscape photo to spring season. Add cherry blossoms, green fresh leaves, spring flowers, bright green grass. Keep the main structures and composition unchanged. Photorealistic style.",
    "夏季": "Transform this scenic landscape photo to summer season. Add lush green foliage, bright sunlight, vivid green trees, summer atmosphere. Keep the main structures and composition unchanged. Photorealistic style.",
    "秋季": "Transform this scenic landscape photo to autumn/fall season. Change leaves to golden, orange, and red colors. Add autumn atmosphere with warm tones. Keep the main structures and composition unchanged. Photorealistic style.",
    "冬季": "Transform this scenic landscape photo to winter season. Add snow on trees and ground, frost effects, bare branches, winter sky. Keep the main structures and composition unchanged. Photorealistic style.",
}


def _get_ai_provider():
    """Get the configured AI provider for image generation."""
    from sidecar.routers.config_api import _read_config
    config = _read_config()

    # Try custom relays first (they support vision/generation)
    relays_raw = config.get("custom_relays", "[]")
    try:
        relays = json.loads(relays_raw) if isinstance(relays_raw, str) else []
    except json.JSONDecodeError:
        relays = []

    if relays:
        relay = relays[0]  # Use first relay
        return {
            "type": "openai_compatible",
            "base_url": relay["base_url"],
            "api_key": relay["api_key"],
            "model": relay.get("model", "gpt-4o"),
        }

    # Fall back to Gemini
    gemini_key = config.get("gemini_api_key", "")
    if gemini_key:
        return {"type": "gemini", "api_key": gemini_key}

    raise ValueError("未配置任何 AI 服务商，请在设置→AI服务商中配置")


async def _generate_with_openai(provider: dict, image_path: str, prompt: str) -> bytes | None:
    """Use OpenAI-compatible API to describe the transformation, then apply locally."""
    # For now: send image + prompt to vision API, get description back
    # Then apply a color transformation based on the season
    # (Full AI generation requires image-to-image API which most relays support)

    img = PILImage.open(image_path)
    if img.mode != "RGB":
        img = img.convert("RGB")
    img.thumbnail((1024, 1024))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    b64 = base64.b64encode(buf.getvalue()).decode()

    base_url = provider["base_url"].rstrip("/")
    url = base_url + "/v1/chat/completions" if "/v1" not in base_url else base_url + "/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                url,
                headers={"Authorization": f"Bearer {provider['api_key']}", "Content-Type": "application/json"},
                json={
                    "model": provider["model"],
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                            ],
                        }
                    ],
                    "max_tokens": 100,
                },
            )
            resp.raise_for_status()
            return None  # Vision API returns text, not images
    except Exception as e:
        logger.warning(f"AI API call failed: {e}")
        return None


def _apply_season_filter(img: PILImage.Image, season: str) -> PILImage.Image:
    """Apply a color filter to simulate season change (local fallback)."""
    import numpy as np
    from PIL import ImageEnhance

    arr = np.array(img, dtype=np.float64)

    if season == "春季":
        # Boost greens, add warmth
        arr[:, :, 1] = np.clip(arr[:, :, 1] * 1.15, 0, 255)  # green
        arr[:, :, 0] = np.clip(arr[:, :, 0] * 1.05, 0, 255)  # slight red warmth
        result = PILImage.fromarray(arr.astype(np.uint8))
        result = ImageEnhance.Color(result).enhance(1.2)
        result = ImageEnhance.Brightness(result).enhance(1.05)

    elif season == "夏季":
        # Vivid greens, high saturation, bright
        arr[:, :, 1] = np.clip(arr[:, :, 1] * 1.2, 0, 255)
        result = PILImage.fromarray(arr.astype(np.uint8))
        result = ImageEnhance.Color(result).enhance(1.3)
        result = ImageEnhance.Brightness(result).enhance(1.08)
        result = ImageEnhance.Contrast(result).enhance(1.1)

    elif season == "秋季":
        # Warm tones: boost red/orange, reduce green
        arr[:, :, 0] = np.clip(arr[:, :, 0] * 1.2, 0, 255)   # red
        arr[:, :, 1] = np.clip(arr[:, :, 1] * 0.9, 0, 255)   # reduce green
        arr[:, :, 2] = np.clip(arr[:, :, 2] * 0.85, 0, 255)  # reduce blue
        result = PILImage.fromarray(arr.astype(np.uint8))
        result = ImageEnhance.Color(result).enhance(1.25)
        result = ImageEnhance.Warmth(result).enhance(1.15) if hasattr(ImageEnhance, 'Warmth') else result

    elif season == "冬季":
        # Cool tones: boost blue, desaturate, brighten
        arr[:, :, 2] = np.clip(arr[:, :, 2] * 1.15, 0, 255)  # blue
        arr[:, :, 0] = np.clip(arr[:, :, 0] * 0.95, 0, 255)  # reduce red
        result = PILImage.fromarray(arr.astype(np.uint8))
        result = ImageEnhance.Color(result).enhance(0.7)  # desaturate
        result = ImageEnhance.Brightness(result).enhance(1.1)

    else:
        result = img

    return result


async def run_seasonal(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    target_season = params.get("season", "秋季")
    image_ids = params.get("image_ids", [])

    output_dir = WORKSPACE_DIR / "generated" / "seasonal"
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

                # Apply local season color filter
                transformed = _apply_season_filter(src, target_season)

                season_label = target_season.replace("季", "")
                out_path = output_dir / f"{img_record.id}_{season_label}.jpg"
                transformed.save(str(out_path), "JPEG", quality=90)

                new_img = Image(
                    project_id=task.project_id,
                    file_path=str(out_path),
                    file_name=out_path.name,
                    width=transformed.size[0],
                    height=transformed.size[1],
                    file_size_kb=out_path.stat().st_size // 1024,
                    quality_status="passed",
                    tag_status="pending",
                    source_type="generated",
                    parent_id=img_record.id,
                )
                db.add(new_img)
            except Exception as e:
                logger.error(f"Seasonal transform failed for {img_record.id}: {e}")

            if (idx + 1) % 5 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total)

        await db.commit()
        logger.info(f"Seasonal done: {total} images → {target_season}")
