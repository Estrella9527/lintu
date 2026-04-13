"""AI tagging engine with retry, fallback provider, and dynamic prompt from tag schema."""

import asyncio
import json
import logging
from datetime import datetime

from sqlalchemy import select, update

from sidecar.db.models import Image, Tag, Task
from sidecar.db.session import async_session
from sidecar.defaults import get_setting
from sidecar.routers.tag_schema import _read_schema

logger = logging.getLogger(__name__)


def _build_prompt_from_schema() -> str:
    """Build tagging prompt dynamically from the current tag schema."""
    schema = _read_schema()
    sections = []
    for dim, def_ in schema.items():
        label = def_.get("label", dim)
        values = def_.get("values", [])
        required = def_.get("required", False)
        multi = def_.get("multi", False)
        req_text = "必选1个" if required else "可选"
        multi_text = "可选多个" if multi else req_text
        vals_str = ", ".join(values)
        sections.append(f"### {dim}（{label}，{multi_text}）\n{vals_str}")

    dims = "\n\n".join(sections)
    return f"""你是一个景区图片分类专家。请分析这张图片，严格从以下预定义标签中选择，以JSON格式输出。

## 标签维度

{dims}

## 输出格式

{{
{chr(10).join(f'  "{dim}": ' + ('"选1个"' if not d.get("multi") else '["可选多个"]') + ',' for dim, d in schema.items())}
  "description": "一句话中文描述，20字以内"
}}

只输出JSON，不要其他文字。标签必须严格使用预定义值，不可自创。"""


def _get_provider(provider_name: str):
    """Instantiate a provider by name, reading api_key from config."""
    from sidecar.routers.config_api import _read_config
    config = _read_config()

    if provider_name == "gemini":
        api_key = config.get("gemini_api_key", "")
        if not api_key:
            raise ValueError("未配置 Gemini API Key")
        from sidecar.providers.gemini import GeminiProvider
        return GeminiProvider(api_key=api_key)
    else:
        # Try as custom relay (OpenAI compatible)
        relays_raw = config.get("custom_relays", "[]")
        try:
            relays = json.loads(relays_raw) if isinstance(relays_raw, str) else []
        except json.JSONDecodeError:
            relays = []
        for relay in relays:
            if relay.get("name") == provider_name:
                from sidecar.providers.openai_compat import OpenAICompatProvider
                return OpenAICompatProvider(
                    base_url=relay["base_url"],
                    api_key=relay["api_key"],
                    model=relay.get("model", "gpt-4o"),
                )
        raise ValueError(f"未找到 Provider: {provider_name}")


async def run_tagging(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    concurrency = params.get("concurrency", get_setting("tagger_max_concurrent"))
    cost_limit = params.get("cost_limit", get_setting("tagger_cost_limit_usd"))
    retry_times = int(get_setting("tagger_retry_times") or 3)
    provider_name = params.get("provider", get_setting("tagger_provider"))
    fallback_name = get_setting("tagger_fallback_provider") or ""

    prompt = _build_prompt_from_schema()

    # Init primary provider
    provider = _get_provider(provider_name)
    consecutive_failures = 0

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
            nonlocal total_cost, processed, failed, provider, consecutive_failures

            async with semaphore:
                last_error = None
                for attempt in range(retry_times):
                    try:
                        result = await provider.tag_image(img.file_path, prompt)
                        tags_data = result["tags"]

                        async with async_session() as inner_db:
                            for dimension, value in tags_data.items():
                                if dimension == "description":
                                    continue
                                if isinstance(value, list):
                                    for v in value:
                                        inner_db.add(Tag(image_id=img.id, dimension=dimension, value=v, source="ai"))
                                elif isinstance(value, str):
                                    inner_db.add(Tag(image_id=img.id, dimension=dimension, value=value, source="ai"))

                            await inner_db.execute(
                                update(Image).where(Image.id == img.id).values(
                                    description=tags_data.get("description"),
                                    tag_status="tagged",
                                    tagged_at=datetime.utcnow(),
                                    tag_provider=provider_name,
                                )
                            )
                            await inner_db.commit()

                        async with lock:
                            total_cost += result.get("cost_usd", 0)
                            processed += 1
                            consecutive_failures = 0
                            if total_cost >= cost_limit:
                                raise Exception(f"达到费用上限 ${total_cost:.4f}")
                            await progress_cb(processed=processed, total=total, cost_usd=total_cost)
                        return  # Success

                    except Exception as e:
                        last_error = e
                        async with lock:
                            consecutive_failures += 1
                            # Switch to fallback after 10 consecutive failures
                            if consecutive_failures >= 10 and fallback_name and fallback_name != provider_name:
                                try:
                                    provider = _get_provider(fallback_name)
                                    provider_name_ref = fallback_name
                                    consecutive_failures = 0
                                    logger.warning(f"Switched to fallback provider: {fallback_name}")
                                except Exception:
                                    pass
                        if attempt < retry_times - 1:
                            await asyncio.sleep(1 * (attempt + 1))

                # All retries failed
                async with lock:
                    failed += 1
                logger.error(f"Failed to tag {img.id} after {retry_times} retries: {last_error}")

        batch_size = int(get_setting("tagger_batch_size") or 10)
        for i in range(0, total, batch_size):
            batch = images[i:i + batch_size]
            await asyncio.gather(*[tag_one(img) for img in batch])

        logger.info(f"Tagging done: {processed} tagged, {failed} failed, cost=${total_cost:.4f}")
