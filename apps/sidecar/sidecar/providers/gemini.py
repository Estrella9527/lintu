"""Gemini provider for image tagging."""

import json
import logging

from PIL import Image as PILImage

from sidecar.providers.base import ImageProvider

logger = logging.getLogger(__name__)

TAGGING_PROMPT = """你是一个景区图片分类专家。请分析这张图片，严格从以下预定义标签中选择，以JSON格式输出。

输出格式：
{
  "scene": "从以下选1个：山地景观/水域/森林步道/游乐设施/餐饮区/住宿区/入口大门/停车场/观景台/商业街区/室内场馆",
  "facility": ["可选多个，没有则为空数组"],
  "season": "春季/夏季/秋季/冬季",
  "weather": "晴天/多云/阴天/雨天/雾天/黄昏/夜景",
  "angle": "俯拍/仰拍/平拍/全景/特写/第一人称视角/航拍",
  "people": "无人/少量游客/人群/工作人员/儿童/吉祥物IP形象",
  "usage": ["小红书封面/朋友圈分享/OTA详情页/宣传海报底图/景区导览/不适合外发"],
  "description": "一句话中文描述，20字以内"
}

只输出JSON，不要其他文字。"""


class GeminiProvider(ImageProvider):
    def __init__(self, api_key: str):
        try:
            import google.generativeai as genai
            genai.configure(api_key=api_key)
            self.model = genai.GenerativeModel("gemini-2.0-flash")
            self._genai = genai
        except ImportError:
            raise ImportError("google-generativeai is required. Run: uv add google-generativeai")

    async def tag_image(self, image_path: str) -> dict:
        img = PILImage.open(image_path)
        img.thumbnail((1024, 1024))

        response = await self.model.generate_content_async(
            [TAGGING_PROMPT, img],
            generation_config={"response_mime_type": "application/json"},
        )

        try:
            tags = json.loads(response.text)
        except json.JSONDecodeError:
            # Try to extract JSON from response
            text = response.text.strip()
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            tags = json.loads(text)

        # Estimate cost (Gemini 2.0 Flash pricing)
        tokens = getattr(response, "usage_metadata", None)
        token_count = tokens.total_token_count if tokens else 500
        cost = token_count * 0.0000001  # rough estimate

        return {"tags": tags, "cost_usd": cost}
