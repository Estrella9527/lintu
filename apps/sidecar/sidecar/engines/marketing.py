"""Marketing material engine: add text overlays and format for platforms."""

import json
import logging
from pathlib import Path

from PIL import Image as PILImage, ImageDraw, ImageFont
from sqlalchemy import select

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)

TEMPLATES = {
    "小红书封面": {"size": (1080, 1440), "text_area": "bottom", "overlay_color": (0, 0, 0, 120)},
    "朋友圈分享": {"size": (1080, 1080), "text_area": "bottom", "overlay_color": (0, 0, 0, 100)},
    "OTA详情页": {"size": (750, 560), "text_area": "none", "overlay_color": None},
    "宣传海报": {"size": (1080, 1920), "text_area": "center", "overlay_color": (0, 0, 0, 140)},
}


def _create_marketing_image(img: PILImage.Image, template: dict, text: str) -> PILImage.Image:
    target_w, target_h = template["size"]

    # Resize to cover
    src_ratio = img.size[0] / img.size[1]
    target_ratio = target_w / target_h

    if src_ratio > target_ratio:
        new_h = target_h
        new_w = int(target_h * src_ratio)
    else:
        new_w = target_w
        new_h = int(target_w / src_ratio)

    resized = img.resize((new_w, new_h), PILImage.Resampling.LANCZOS)

    # Center crop
    left = (new_w - target_w) // 2
    top = (new_h - target_h) // 2
    cropped = resized.crop((left, top, left + target_w, top + target_h))

    # Add text overlay if configured
    if template["text_area"] != "none" and text:
        result = cropped.convert("RGBA")
        overlay = PILImage.new("RGBA", result.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        # Text area position
        if template["text_area"] == "bottom":
            box_h = target_h // 4
            box = (0, target_h - box_h, target_w, target_h)
        elif template["text_area"] == "center":
            box_h = target_h // 3
            box_y = (target_h - box_h) // 2
            box = (0, box_y, target_w, box_y + box_h)
        else:
            box = (0, 0, target_w, target_h // 4)

        if template["overlay_color"]:
            draw.rectangle(box, fill=template["overlay_color"])

        # Draw text
        try:
            font = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 36)
        except (OSError, IOError):
            font = ImageFont.load_default()

        text_x = target_w // 2
        text_y = (box[1] + box[3]) // 2
        draw.text((text_x, text_y), text, fill=(255, 255, 255, 230), font=font, anchor="mm")

        result = PILImage.alpha_composite(result, overlay).convert("RGB")
    else:
        result = cropped

    return result


async def run_marketing(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    template_name = params.get("template", "小红书封面")
    text = params.get("text", "")
    image_ids = params.get("image_ids", [])

    template = TEMPLATES.get(template_name, TEMPLATES["小红书封面"])

    output_dir = WORKSPACE_DIR / "generated" / "marketing"
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
                result_img = _create_marketing_image(src, template, text)

                safe_name = template_name.replace("/", "_")
                out_path = output_dir / f"{img_record.id}_{safe_name}.jpg"
                result_img.save(str(out_path), "JPEG", quality=92)

                db.add(Image(
                    project_id=task.project_id, file_path=str(out_path), file_name=out_path.name,
                    width=result_img.size[0], height=result_img.size[1],
                    file_size_kb=out_path.stat().st_size // 1024,
                    quality_status="passed", tag_status="pending", source_type="generated", parent_id=img_record.id,
                ))
            except Exception as e:
                logger.error(f"Marketing failed for {img_record.id}: {e}")

            if (idx + 1) % 5 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total)

        await db.commit()
        logger.info(f"Marketing done: {total} images, template={template_name}")
