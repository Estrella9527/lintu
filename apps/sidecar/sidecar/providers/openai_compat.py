"""OpenAI-compatible provider for vision tagging AND image generation."""

import base64
import io
import json
import logging

import httpx
from PIL import Image as PILImage

from sidecar.providers.base import ImageProvider

logger = logging.getLogger(__name__)


def _encode_image(image_path: str, max_size: int = 1024) -> str:
    """Load, resize, and base64-encode an image."""
    img = PILImage.open(image_path)
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")
    img.thumbnail((max_size, max_size))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def _build_url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        return base + path
    return base + "/v1" + path


class OpenAICompatProvider(ImageProvider):
    def __init__(self, base_url: str, api_key: str, model: str = "gpt-4o"):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    # ── Vision / Tagging ──

    async def tag_image(self, image_path: str, prompt: str | None = None) -> dict:
        b64 = _encode_image(image_path)
        url = _build_url(self.base_url, "/chat/completions")

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, headers=self._headers, json={
                "model": self.model,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": prompt or "Describe this image."},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ]}],
                "max_tokens": 1000,
            })
            resp.raise_for_status()
            data = resp.json()

        text = data["choices"][0]["message"]["content"]
        text = text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        tags = json.loads(text.strip())

        usage = data.get("usage", {})
        cost = usage.get("total_tokens", 500) * 0.000003

        return {"tags": tags, "cost_usd": cost}

    # ── Image Generation (img2img) ──

    async def generate_image(self, image_path: str, prompt: str, **kwargs) -> dict:
        """Try Chat Completions with image output first, fallback to Images API."""
        try:
            return await self._generate_via_chat(image_path, prompt, **kwargs)
        except Exception as e:
            logger.info(f"Chat generation failed ({e}), trying Images API...")
            try:
                return await self._generate_via_images_api(image_path, prompt, **kwargs)
            except Exception as e2:
                logger.warning(f"Images API also failed ({e2}), generation not supported")
                raise

    async def _generate_via_chat(self, image_path: str, prompt: str, **kwargs) -> dict:
        """Format B: Chat Completions — model returns image in response."""
        b64 = _encode_image(image_path)
        url = _build_url(self.base_url, "/chat/completions")

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, headers=self._headers, json={
                "model": self.model,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ]}],
                "max_tokens": 4096,
            })
            resp.raise_for_status()
            data = resp.json()

        message = data["choices"][0]["message"]
        content = message.get("content", "")

        # Check if response contains image data
        image_data = None

        # Case 1: content is a list with image blocks (OpenAI GPT-4o style)
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "image_url":
                        img_url = block.get("image_url", {}).get("url", "")
                        if img_url.startswith("data:image"):
                            b64_data = img_url.split(",", 1)[1]
                            image_data = base64.b64decode(b64_data)
                    elif block.get("type") == "image" and "source" in block:
                        image_data = base64.b64decode(block["source"].get("data", ""))

        # Case 2: content is string with embedded base64 image
        if not image_data and isinstance(content, str):
            # Look for base64 image data in markdown
            import re
            img_match = re.search(r'data:image/[^;]+;base64,([A-Za-z0-9+/=]+)', content)
            if img_match:
                image_data = base64.b64decode(img_match.group(1))

        if not image_data:
            raise ValueError("Model response did not contain image data")

        usage = data.get("usage", {})
        cost = usage.get("total_tokens", 1000) * 0.00001

        return {"image_data": image_data, "cost_usd": cost}

    async def _generate_via_images_api(self, image_path: str, prompt: str, **kwargs) -> dict:
        """Format A: OpenAI Images API — /v1/images/edits."""
        b64 = _encode_image(image_path)
        url = _build_url(self.base_url, "/images/edits")

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, headers=self._headers, json={
                "model": self.model,
                "image": b64,
                "prompt": prompt,
                "n": 1,
                "response_format": "b64_json",
            })
            resp.raise_for_status()
            data = resp.json()

        b64_result = data["data"][0].get("b64_json", "")
        if not b64_result:
            url_result = data["data"][0].get("url", "")
            if url_result:
                async with httpx.AsyncClient(timeout=30) as client:
                    img_resp = await client.get(url_result)
                    image_data = img_resp.content
            else:
                raise ValueError("No image data in response")
        else:
            image_data = base64.b64decode(b64_result)

        return {"image_data": image_data, "cost_usd": 0.02}
