"""Gemini provider for image tagging."""

import json
import logging

from PIL import Image as PILImage

from sidecar.providers.base import ImageProvider

logger = logging.getLogger(__name__)

# Register HEIC support if available
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass


class GeminiProvider(ImageProvider):
    def __init__(self, api_key: str):
        try:
            import google.generativeai as genai
            genai.configure(api_key=api_key)
            self.model = genai.GenerativeModel("gemini-2.0-flash")
        except ImportError:
            raise ImportError("google-generativeai is required. Run: uv add google-generativeai")

    async def tag_image(self, image_path: str, prompt: str | None = None) -> dict:
        img = PILImage.open(image_path)
        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")
        img.thumbnail((1024, 1024))

        use_prompt = prompt or "Describe this image in JSON."

        response = await self.model.generate_content_async(
            [use_prompt, img],
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
        token_count = tokens.total_token_count if tokens else 500
        cost = token_count * 0.0000001

        return {"tags": tags, "cost_usd": cost}
