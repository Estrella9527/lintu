"""On-demand thumbnail generation with filesystem cache."""

from pathlib import Path

from PIL import Image as PILImage

THUMBNAIL_SIZES = (128, 300, 800)


def get_thumbnail_path(image_id: str, size: int, cache_dir: Path) -> Path:
    return cache_dir / str(size) / image_id[:2] / f"{image_id}.jpg"


def invalidate_thumbnails(image_id: str, cache_dir: Path) -> int:
    """Delete every cached thumbnail for this image_id (all sizes). Returns count."""
    removed = 0
    for size in THUMBNAIL_SIZES:
        p = get_thumbnail_path(image_id, size, cache_dir)
        if p.exists():
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def generate_thumbnail(source_path: str, output_path: Path, size: int):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img = PILImage.open(source_path)
    img.thumbnail((size, size), PILImage.Resampling.LANCZOS)
    if img.mode in ("RGBA", "LA", "P"):
        # JPEG 不支持 alpha — 直接 .convert("RGB") 会把透明像素染成黑色,
        # 用户上传的 PNG 截图(常含透明边)缩略图会一片黑。
        # 修法:在白色画布上合成,把 alpha 通道当 mask 贴上去。
        rgba = img.convert("RGBA")
        bg = PILImage.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[-1])
        img = bg
    img.save(output_path, "JPEG", quality=85, optimize=True)
