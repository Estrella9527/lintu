"""Upscale engine: PIL-based Lanczos upscaling (no external model needed)."""

import json
import logging
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)


async def run_upscale(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    scale = params.get("scale", 2)
    image_ids = params.get("image_ids", [])

    output_dir = WORKSPACE_DIR / "generated" / "upscale"
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
                new_size = (src.size[0] * scale, src.size[1] * scale)
                upscaled = src.resize(new_size, PILImage.Resampling.LANCZOS)

                out_path = output_dir / f"{img_record.id}_{scale}x.jpg"
                if upscaled.mode in ("RGBA", "P"):
                    upscaled = upscaled.convert("RGB")
                upscaled.save(str(out_path), "JPEG", quality=92)

                new_img = Image(
                    project_id=task.project_id,
                    file_path=str(out_path),
                    file_name=out_path.name,
                    width=new_size[0],
                    height=new_size[1],
                    file_size_kb=out_path.stat().st_size // 1024,
                    quality_status="passed",
                    tag_status="pending",
                    source_type="generated",
                    parent_id=img_record.id,
                )
                db.add(new_img)
            except Exception as e:
                logger.error(f"Upscale failed for {img_record.id}: {e}")

            if (idx + 1) % 5 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total)

        await db.commit()
        logger.info(f"Upscale done: {total} images at {scale}x")
