"""Base image provider interface — filled in M5."""

from abc import ABC, abstractmethod


class ImageProvider(ABC):
    @abstractmethod
    async def tag_image(self, image_path: str) -> dict:
        """Tag an image and return structured tags + cost."""
        ...
