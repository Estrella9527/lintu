"""Shared utilities for AI generation engines."""

import json
import logging
from pathlib import Path

from sidecar.defaults import get_setting

logger = logging.getLogger(__name__)

# Image generation model — separate from the chat/tagging model
DEFAULT_IMAGE_MODEL = "nano-banana-2"


def get_generation_provider():
    """Get AI provider configured for IMAGE GENERATION (not tagging).
    Uses nano-banana-2 model by default, overridable via config."""
    from sidecar.routers.config_api import _read_config
    config = _read_config()

    image_model = config.get("generation_model", DEFAULT_IMAGE_MODEL)

    # Try custom relays first
    relays_raw = config.get("custom_relays", "[]")
    try:
        relays = json.loads(relays_raw) if isinstance(relays_raw, str) else []
    except json.JSONDecodeError:
        relays = []

    if relays:
        from sidecar.providers.openai_compat import OpenAICompatProvider
        relay = relays[0]
        logger.info(f"Using relay '{relay.get('name')}' with model '{image_model}' for generation")
        return OpenAICompatProvider(
            base_url=relay["base_url"],
            api_key=relay["api_key"],
            model=image_model,
        )

    # Fall back to Gemini
    gemini_key = config.get("gemini_api_key", "")
    if gemini_key:
        from sidecar.providers.gemini import GeminiProvider
        logger.info("Using Gemini for generation")
        return GeminiProvider(api_key=gemini_key)

    raise ValueError("未配置任何 AI 服务商。请在设置→AI服务商中配置。")


def get_prompt_template(category: str, default: str, **format_args) -> str:
    """Get prompt from DB prompts table, fallback to default."""
    try:
        from sidecar.db.session import async_session
        from sidecar.db.models import Prompt
        from sqlalchemy import select
        import asyncio

        async def _fetch():
            async with async_session() as db:
                result = await db.execute(
                    select(Prompt)
                    .where(Prompt.category == category, Prompt.is_default == True)
                    .limit(1)
                )
                return result.scalar_one_or_none()

        prompt = asyncio.get_event_loop().run_until_complete(_fetch())
        if prompt:
            template = prompt.content
            for k, v in format_args.items():
                template = template.replace(f"{{{k}}}", str(v))
            return template
    except Exception:
        pass

    return default.format(**format_args)


def save_generated_image(image_data: bytes, output_path: Path):
    """Save raw image bytes to file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(image_data)
