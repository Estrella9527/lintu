"""AI tagging engine using configurable image providers."""

import asyncio
import json
import logging
from datetime import datetime

from sqlalchemy import select, update

from sidecar.db.models import Image, Tag, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)


def _get_config_value(key: str, default: str = "") -> str:
    """Read config from DB synchronously (called within async context)."""
    # Simple file-based config fallback
    from sidecar.config import DATA_DIR
    config_file = DATA_DIR / "config.json"
    if config_file.exists():
        import json as _json
        data = _json.loads(config_file.read_text())
        return data.get(key, default)
    return default


async def run_tagging(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    concurrency = params.get("concurrency", 5)
    cost_limit = params.get("cost_limit", 10.0)

    # Get API key from config
    api_key = _get_config_value("gemini_api_key")
    if not api_key:
        raise ValueError("未配置 Gemini API Key，请在 设置→AI服务商 中配置")

    from sidecar.providers.gemini import GeminiProvider
    provider = GeminiProvider(api_key=api_key)

    async with async_session() as db:
        result = await db.execute(
            select(Image)
            .where(Image.project_id == task.project_id)
            .where(Image.quality_status == "passed")
            .where(Image.is_kept == True)  # noqa: E712
            .where(Image.tag_status == "pending")
        )
        images = result.scalars().all()
        total = len(images)

        await progress_cb(total=total, processed=0, cost_usd=0.0)

        semaphore = asyncio.Semaphore(concurrency)
        total_cost = 0.0
        processed = 0
        failed = 0
        lock = asyncio.Lock()

        async def tag_one(img: Image):
            nonlocal total_cost, processed, failed

            async with semaphore:
                try:
                    result = await provider.tag_image(img.file_path)
                    tags_data = result["tags"]

                    async with async_session() as inner_db:
                        # Save tags
                        for dimension, value in tags_data.items():
                            if dimension == "description":
                                continue
                            if isinstance(value, list):
                                for v in value:
                                    inner_db.add(Tag(
                                        image_id=img.id,
                                        dimension=dimension,
                                        value=v,
                                        source="ai",
                                    ))
                            elif isinstance(value, str):
                                inner_db.add(Tag(
                                    image_id=img.id,
                                    dimension=dimension,
                                    value=value,
                                    source="ai",
                                ))

                        await inner_db.execute(
                            update(Image).where(Image.id == img.id).values(
                                description=tags_data.get("description"),
                                tag_status="tagged",
                                tagged_at=datetime.utcnow(),
                                tag_provider="gemini",
                            )
                        )
                        await inner_db.commit()

                    async with lock:
                        total_cost += result["cost_usd"]
                        processed += 1
                        await progress_cb(
                            processed=processed,
                            total=total,
                            cost_usd=total_cost,
                        )

                        if total_cost >= cost_limit:
                            raise Exception(f"达到费用上限 ${total_cost:.4f}")

                except Exception as e:
                    async with lock:
                        failed += 1
                    logger.error(f"Failed to tag {img.id}: {e}")

        # Run in batches to avoid overwhelming
        batch_size = concurrency * 2
        for i in range(0, total, batch_size):
            batch = images[i:i + batch_size]
            await asyncio.gather(*[tag_one(img) for img in batch])

        logger.info(f"Tagging done: {processed} tagged, {failed} failed, cost=${total_cost:.4f}")
