"""OpenAI-compatible provider for image tagging via vision API."""

import base64
import json
import logging
from pathlib import Path

import httpx
from PIL import Image as PILImage

from sidecar.providers.base import ImageProvider

logger = logging.getLogger(__name__)


class OpenAICompatProvider(ImageProvider):
    def __init__(self, base_url: str, api_key: str, model: str = "gpt-4o"):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def tag_image(self, image_path: str, prompt: str | None = None) -> dict:
        # Resize and encode image
        img = PILImage.open(image_path)
        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")
        img.thumbnail((1024, 1024))

        import io
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode()

        # Build chat completion request
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt or "Describe this image."},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ],
            }
        ]

        url = self.base_url + "/v1/chat/completions" if "/v1" not in self.base_url else self.base_url + "/chat/completions"

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                url,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={"model": self.model, "messages": messages, "max_tokens": 1000},
            )
            resp.raise_for_status()
            data = resp.json()

        text = data["choices"][0]["message"]["content"]

        # Parse JSON from response (handle markdown fences)
        text = text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        tags = json.loads(text.strip())

        # Estimate cost
        usage = data.get("usage", {})
        total_tokens = usage.get("total_tokens", 500)
        cost = total_tokens * 0.000003  # rough estimate for vision models

        return {"tags": tags, "cost_usd": cost}
