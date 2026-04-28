"""Provider base class, shared exceptions, and retry/transient classification.

A provider exposes `tag_image()` (vision) and optionally `generate_image()`
(image-to-image). Errors raised should be classified as either:

  - TransientError  → retry safe (network, 5xx, timeout, throttling)
  - PermanentError  → do NOT retry (invalid prompt, content policy, 4xx, output invalid)

The RetryMixin runs an inner async coroutine with bounded retries +
exponential backoff. It is intentionally minimal — caller decides which
provider to switch to next via the GenerationPipeline.
"""
from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from typing import Awaitable, Callable, TypeVar

import httpx

logger = logging.getLogger(__name__)

T = TypeVar("T")


class ProviderError(Exception):
    """Base exception for all provider failures."""


class TransientError(ProviderError):
    """Retriable failure — network blip, 5xx, throttling."""


class PermanentError(ProviderError):
    """Non-retriable failure — bad prompt, content policy, 4xx."""


class InvalidOutput(PermanentError):
    """Provider returned data but it did not pass validation."""


def classify_http_error(exc: BaseException) -> ProviderError:
    """Map a raw exception into Transient/Permanent for the retry layer.

    Defaults to TransientError when uncertain, since false-positive retries are
    cheaper than missed retries during long batches.
    """
    if isinstance(exc, ProviderError):
        return exc
    if isinstance(exc, asyncio.TimeoutError):
        return TransientError(f"timeout: {exc}")
    if isinstance(exc, httpx.TimeoutException):
        return TransientError(f"http timeout: {exc}")
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in (408, 425, 429) or 500 <= status < 600:
            return TransientError(f"http {status}: {exc}")
        return PermanentError(f"http {status}: {exc}")
    if isinstance(exc, httpx.HTTPError):
        return TransientError(f"http error: {exc}")
    return TransientError(str(exc))


class RetryMixin:
    """Mix-in that gives a provider a bounded retry helper.

    Modeled on the tagger.py loop: bounded attempts with linear backoff
    (1s, 2s, 3s …). Used by `generate_image()` impls that want resilience
    against transient hiccups before falling back to the next provider.
    """

    DEFAULT_RETRIES = 2  # 1 initial + 2 retries = 3 total attempts

    async def with_retry(
        self,
        op: Callable[[], Awaitable[T]],
        *,
        retries: int | None = None,
        on_retry: Callable[[int, BaseException], None] | None = None,
    ) -> T:
        attempts = retries if retries is not None else self.DEFAULT_RETRIES
        last_err: ProviderError | None = None
        for attempt in range(attempts + 1):
            try:
                return await op()
            except Exception as raw_exc:
                err = classify_http_error(raw_exc)
                last_err = err
                if isinstance(err, PermanentError):
                    raise err from raw_exc
                if attempt >= attempts:
                    break
                wait_s = 1.0 * (attempt + 1)
                if on_retry:
                    on_retry(attempt + 1, raw_exc)
                logger.info("retrying after %.1fs (attempt %d/%d): %s", wait_s, attempt + 1, attempts, err)
                await asyncio.sleep(wait_s)
        assert last_err is not None
        raise last_err


class ImageProvider(RetryMixin, ABC):
    """Abstract base for tagging + image generation providers."""

    name: str = "unknown"

    @abstractmethod
    async def tag_image(self, image_path: str, prompt: str | None = None) -> dict:
        """Vision/tagging: returns {"tags": {...}, "cost_usd": float}."""
        ...

    async def generate_image(self, image_path: str, prompt: str, **kwargs) -> dict:
        """Image-to-image: returns {"image_data": bytes, "cost_usd": float}.

        Providers without image generation should leave this raising
        NotImplementedError; the GenerationPipeline treats that as a permanent
        capability gap and skips to the next provider.
        """
        raise NotImplementedError("This provider does not support image generation")
