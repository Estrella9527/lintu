"""Unified AI image-generation pipeline.

Used by:
  - The legacy single-task engines (outpaint/style/seasonal/inpaint), which
    keep their PIL fallbacks for ad-hoc workshop use.
  - The BatchScheduler (S2.3), which calls the pipeline directly and must
    NOT silently fall back to PIL — bad pixels poison the dataset.

The pipeline encapsulates:
  1. Seed-image preprocessing (HEIC etc.)
  2. Trying each Provider in chain order with bounded retry
  3. Output validation (size + PIL.verify) before declaring success
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable

from sidecar.defaults import get_setting
from sidecar.engines.image_utils import is_valid_image_bytes
from sidecar.providers.base import (
    ImageProvider,
    InvalidOutput,
    PermanentError,
    ProviderError,
    TransientError,
    classify_http_error,
)
from sidecar.providers.registry import build_chain

logger = logging.getLogger(__name__)


@dataclass
class GenerationResult:
    image_data: bytes
    cost_usd: float
    provider_used: str
    attempts: int


class GenerationPipeline:
    """Stateless executor — safe to share as a module-level singleton."""

    async def execute(
        self,
        seed_image_path: str,
        prompt: str,
        *,
        provider_chain: list[ImageProvider] | list[str] | None = None,
        image_model: str | None = None,
        size: str | None = None,
    ) -> GenerationResult:
        chain = self._resolve_chain(provider_chain, image_model=image_model)
        if not chain:
            raise PermanentError("No AI providers configured")

        retries = int(get_setting("generation_max_retries") or 2)
        min_bytes = int(get_setting("generation_min_output_bytes") or 16384)

        # Per-call > global config; provider falls back to its own default
        # when both are empty.
        effective_size = size or (get_setting("image_output_size") or "").strip() or None

        attempts_total = 0
        last_err: ProviderError | None = None

        for provider in chain:
            try:
                attempts_total += 1
                result = await provider.with_retry(
                    lambda p=provider: p.generate_image(
                        seed_image_path, prompt,
                        **({"size": effective_size} if effective_size else {}),
                    ),
                    retries=retries,
                )
            except NotImplementedError:
                logger.info("provider %s lacks generate_image, skipping", provider.name)
                continue
            except PermanentError as e:
                # Permanent errors are bad-prompt / content-policy / 4xx.
                # They will recur with the next provider — bail out fast.
                logger.warning("permanent error from %s: %s", provider.name, e)
                last_err = e
                break
            except Exception as e:
                last_err = classify_http_error(e)
                logger.warning("provider %s failed: %s — trying next", provider.name, last_err)
                continue

            data = result.get("image_data") if isinstance(result, dict) else None
            if not data or not is_valid_image_bytes(data, min_bytes=min_bytes):
                last_err = InvalidOutput(f"{provider.name} returned invalid image bytes")
                logger.warning("invalid output from %s — trying next", provider.name)
                continue

            return GenerationResult(
                image_data=data,
                cost_usd=float(result.get("cost_usd", 0.0)),
                provider_used=provider.name,
                attempts=attempts_total,
            )

        if isinstance(last_err, PermanentError):
            raise last_err
        raise TransientError(f"All providers exhausted: {last_err}") if last_err else TransientError(
            "All providers exhausted"
        )

    @staticmethod
    def _resolve_chain(
        chain: Iterable[ImageProvider] | Iterable[str] | None,
        *,
        image_model: str | None = None,
    ) -> list[ImageProvider]:
        if chain is None:
            return build_chain(None, image_model=image_model)
        materialized: list[ImageProvider] = []
        names: list[str] = []
        for item in chain:
            if isinstance(item, str):
                names.append(item)
            else:
                materialized.append(item)
        if names:
            materialized = build_chain(names, image_model=image_model) + materialized
        return materialized


pipeline = GenerationPipeline()
