"""Gemini provider for vision tagging AND image generation."""

import base64
import io
import json
import logging

from PIL import Image as PILImage

from sidecar.engines.image_utils import register_heif
from sidecar.providers.base import ImageProvider

logger = logging.getLogger(__name__)

register_heif()


class GeminiProvider(ImageProvider):
    def __init__(self, api_key: str):
        try:
            import google.generativeai as genai
            genai.configure(api_key=api_key)
            self.model = genai.GenerativeModel("gemini-2.0-flash")
            self._genai = genai
        except ImportError:
            raise ImportError("google-generativeai required. Run: uv add google-generativeai")

    def _load_image(self, image_path: str, max_size: int = 2048) -> PILImage.Image:
        img = PILImage.open(image_path)
        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")
        img.thumbnail((max_size, max_size))
        return img

    # ── Vision / Tagging ──

    async def tag_image(self, image_path: str, prompt: str | None = None) -> dict:
        img = self._load_image(image_path)
        response = await self.model.generate_content_async(
            [prompt or "Describe this image in JSON.", img],
            generation_config={"response_mime_type": "application/json"},
        )
        try:
            tags = json.loads(response.text)
        except json.JSONDecodeError:
            text = response.text.strip()
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            tags = json.loads(text)

        tokens = getattr(response, "usage_metadata", None)
        cost = (tokens.total_token_count if tokens else 500) * 0.0000001
        return {"tags": tags, "cost_usd": cost}

    # ── Image Generation ──

    async def generate_image(self, image_path: str, prompt: str, **kwargs) -> dict:
        """Gemini image generation via generate_content with image output."""
        img = self._load_image(image_path)

        try:
            response = await self.model.generate_content_async(
                [prompt, img],
                generation_config={"response_mime_type": "image/jpeg"},
            )
            # Gemini returns image as part of response
            if hasattr(response, 'candidates') and response.candidates:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        image_data = part.inline_data.data
                        tokens = getattr(response, "usage_metadata", None)
                        cost = (tokens.total_token_count if tokens else 1000) * 0.000001
                        return {"image_data": image_data, "cost_usd": cost}

            raise ValueError("Gemini response did not contain image data")

        except Exception as e:
            # Fallback: try without response_mime_type (some models don't support it)
            logger.info(f"Gemini image generation failed: {e}")
            raise
