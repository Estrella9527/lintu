"""Image preprocessing helpers shared by every engine.

Centralizes HEIC opener registration and seed-image preparation so each
engine no longer carries its own `register_heif_opener()` boilerplate
(previously scattered across gemini.py, quality_check.py, scan.py).
"""
from __future__ import annotations

import io
import logging
from pathlib import Path

from PIL import Image as PILImage

logger = logging.getLogger(__name__)


def register_heif() -> None:
    """Register the HEIF/HEIC opener with Pillow if available. Idempotent."""
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except ImportError:
        logger.debug("pillow_heif not installed; HEIC inputs will fail")


# Register at import time so any module that imports this gets HEIC support.
register_heif()


def load_seed(image_path: str | Path, *, max_size: int = 1024) -> PILImage.Image:
    """Open an image, normalize mode/size, ready for an AI provider."""
    img = PILImage.open(str(image_path))
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")
    elif img.mode != "RGB":
        img = img.convert("RGB")
    img.thumbnail((max_size, max_size))
    return img


def save_image_bytes(image_data: bytes, output_path: Path) -> None:
    """Write raw image bytes to disk, creating parents."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(image_data)


# ── Magic-byte format detection for API response bytes ────────────────────────

_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff",       "jpg"),   # JFIF / EXIF / SPIFF all start with FF D8 FF
    (b"GIF87a",             "gif"),
    (b"GIF89a",             "gif"),
    (b"RIFF",               "webp"),  # RIFF....WEBP — confirmed below
    (b"BM",                 "bmp"),
)


def detect_image_extension(data: bytes) -> str:
    """Return file extension (no dot) inferred from raw bytes. Defaults to 'bin'."""
    if not data:
        return "bin"
    head = data[:16]
    for sig, ext in _MAGIC:
        if head.startswith(sig):
            if ext == "webp" and not (len(data) >= 12 and data[8:12] == b"WEBP"):
                continue
            return ext
    return "bin"


def effective_file_path(image_record) -> str:
    """Return the path consumers should read for an Image.

    Prefer the lossless rotated derivative when present; otherwise the
    original. This is the ONLY safe way to read image bytes downstream.
    """
    rotated = getattr(image_record, "rotated_file_path", None)
    return rotated or image_record.file_path


def compute_perceptual_hashes(image_path: str | Path) -> dict | None:
    """Compute pHash + dHash + aHash for an image, return JSON-serializable dict.

    Returns `{"p": "...", "d": "...", "a": "..."}` matching dedup's HashTriple
    storage format, or None if the file can't be hashed. Used by both the
    scan engine (auto-hash on import) and the dedup engine (lazy fallback).
    """
    try:
        import imagehash
        with PILImage.open(str(image_path)) as raw:
            img = raw.convert("RGB")
            img.thumbnail((512, 512))
            return {
                "p": str(imagehash.phash(img)),
                "d": str(imagehash.dhash(img)),
                "a": str(imagehash.average_hash(img)),
            }
    except Exception as e:
        logger.warning("hash failed for %s: %s", image_path, e)
        return None


def is_valid_image_bytes(data: bytes, *, min_bytes: int = 4096) -> bool:
    """Sanity-check raw bytes purportedly containing an image.

    A small non-zero byte string can pass simple length checks but still not
    be a real image; PIL.verify confirms it can be decoded.
    """
    if not data or len(data) < min_bytes:
        return False
    try:
        with PILImage.open(io.BytesIO(data)) as img:
            img.verify()
        return True
    except Exception as e:
        logger.debug("image verify failed: %s", e)
        return False
