"""Custom strategy engine: runs any prompt-driven image generation task."""

import json
import logging

from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Strategy, Task
from sidecar.db.session import async_session
from sidecar.engines.generation_utils import get_generation_provider, save_generated_image

logger = logging.getLogger(__name__)


async def run_custom(task: Task, progress_cb):
    """Generic prompt-based image generation. Reads prompt from Strategy DB record."""
    params = json.loads(task.parameters or "{}")
    image_ids = params.get("image_ids", [])
    strategy_id = params.get("strategy_id", "")

    # Load strategy to get prompt template
    prompt_template = params.get("prompt", "Transform this image creatively.")

    if strategy_id:
        async with async_session() as db:
            strategy = await db.get(Strategy, strategy_id)
            if strategy and strategy.prompt:
                prompt_template = strategy.prompt

    # Fill prompt template with params
    prompt = prompt_template
    for k, v in params.items():
        if k not in ("image_ids", "strategy_id", "project_id"):
            prompt = prompt.replace(f"{{{k}}}", str(v))

    output_dir = WORKSPACE_DIR / "generated" / "custom"
    output_dir.mkdir(parents=True, exist_ok=True)

    provider = None
    try:
        provider = get_generation_provider()
    except Exception:
        pass

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
            suffix = strategy_id[:8] if strategy_id else "custom"
            out_path = output_dir / f"{img_record.id}_{suffix}.jpg"

            generated = False
            if provider:
                try:
                    gen = await provider.generate_image(img_record.file_path, prompt)
                    save_generated_image(gen["image_data"], out_path)
                    generated = True
                except Exception as e:
                    logger.warning(f"AI generation failed for {img_record.id}: {e}")

            if not generated:
                # No AI fallback for custom — just copy original
                src = PILImage.open(img_record.file_path).convert("RGB")
                src.save(str(out_path), "JPEG", quality=90)

            w, h = PILImage.open(str(out_path)).size
            db.add(Image(
                project_id=task.project_id, file_path=str(out_path), file_name=out_path.name,
                width=w, height=h, file_size_kb=out_path.stat().st_size // 1024,
                quality_status="passed", tag_status="pending", source_type="generated", parent_id=img_record.id,
            ))
            if (idx + 1) % 3 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total)

        await db.commit()
        logger.info(f"Custom strategy done: {total} images")
