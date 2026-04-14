from abc import ABC, abstractmethod


class ImageProvider(ABC):
    @abstractmethod
    async def tag_image(self, image_path: str, prompt: str | None = None) -> dict:
        """Vision/tagging: Returns {"tags": {...}, "cost_usd": float}."""
        ...

    async def generate_image(self, image_path: str, prompt: str, **kwargs) -> dict:
        """Image-to-image generation: Returns {"image_data": bytes, "cost_usd": float}.
        Raises NotImplementedError if provider doesn't support generation."""
        raise NotImplementedError("This provider does not support image generation")
