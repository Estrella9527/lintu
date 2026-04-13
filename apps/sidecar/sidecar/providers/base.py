from abc import ABC, abstractmethod


class ImageProvider(ABC):
    @abstractmethod
    async def tag_image(self, image_path: str, prompt: str | None = None) -> dict:
        """Tag an image. Returns {"tags": {...}, "cost_usd": float}."""
        ...
