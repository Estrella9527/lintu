"""Shared utilities for AI generation engines.

`get_generation_provider()` is kept as a thin compatibility shim — new code
should call `GenerationPipeline.execute(...)` directly. Engines that still
maintain a PIL fallback (single-task workshop use) call the pipeline first
and catch its errors.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from sidecar.engines.image_utils import save_image_bytes  # re-export for legacy callers
from sidecar.providers.registry import get_default_chain, get_provider

logger = logging.getLogger(__name__)


def get_generation_provider():
    """Compatibility shim — first provider in the default chain."""
    chain = get_default_chain()
    if not chain:
        raise ValueError("未配置任何 AI 服务商。请在设置→AI服务商中配置。")
    return chain[0]


def get_prompt_template(category: str, default: str, **format_args) -> str:
    """Pull a prompt template from DB by category+is_default. Falls back
    to the engine-local default. Format args fill {var} placeholders."""
    try:
        from sidecar.db.session import async_session
        from sidecar.db.models import Prompt
        from sqlalchemy import select

        async def _fetch():
            async with async_session() as db:
                result = await db.execute(
                    select(Prompt)
                    .where(Prompt.category == category)
                    .where(Prompt.is_default == True)  # noqa: E712
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
    """Legacy alias kept so existing engines keep importing from here."""
    save_image_bytes(image_data, output_path)


__all__ = ["get_generation_provider", "get_prompt_template", "save_generated_image", "get_provider"]
