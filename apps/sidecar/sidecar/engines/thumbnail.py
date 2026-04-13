"""On-demand thumbnail generation with filesystem cache."""

from pathlib import Path

from PIL import Image as PILImage

THUMBNAIL_SIZES = (128, 300, 800)


def get_thumbnail_path(image_id: str, size: int, cache_dir: Path) -> Path:
    return cache_dir / str(size) / image_id[:2] / f"{image_id}.jpg"


def generate_thumbnail(source_path: str, output_path: Path, size: int):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img = PILImage.open(source_path)
    img.thumbnail((size, size), PILImage.Resampling.LANCZOS)
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    img.save(output_path, "JPEG", quality=85, optimize=True)
