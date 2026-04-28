"""Orientation correction engine.

Two-stage pipeline:

  1. **EXIF pass** (always, fast, free): apply `ImageOps.exif_transpose` and
     strip the tag. Handles most camera photos correctly.

  2. **AI vision pass** (optional, `mode='auto+ai'`): for images that the
     EXIF pass didn't change, ask the user-selected GENERAL provider to
     classify the current orientation. Prompt asks for one of:
         correct | rotate_cw | rotate_ccw | rotate_180
     Each AI-fixed image is saved back in the chosen rotation and marked
     `orient_status='ai'` so repeat runs skip it.

  3. **Manual rotations** (`rotate_cw`/`rotate_ccw`/`rotate_180`): as before —
     rotate every target image by a fixed amount, user-driven.

Budget guard: `max_ai_images` (default 500) caps AI calls per task.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import shutil
import subprocess
from pathlib import Path

from PIL import Image as PILImage, ImageOps
from sqlalchemy import select, update

from sidecar.config import DERIVED_DIR, THUMBNAILS_DIR
from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.engines.image_utils import register_heif
from sidecar.engines.thumbnail import invalidate_thumbnails
from sidecar.providers.registry import get_general_provider_target

register_heif()
logger = logging.getLogger(__name__)


_ROTATION_BY_DEGREES = {
    # Map our directive → PIL.rotate argument (counter-clockwise degrees).
    # PIL rotates counter-clockwise by default.
    "rotate_cw": 270,
    "rotate_ccw": 90,
    "rotate_180": 180,
}

AI_INSTRUCTION = (
    "你是照片方向检查助手。判断这张照片当前显示方向是否需要旋转。"
    "只回复一个英文单词：correct | rotate_cw | rotate_ccw | rotate_180。"
    "correct = 当前方向已经正确。"
    "rotate_cw = 当前向左倒了 90°，需要顺时针旋转 90° 矫正。"
    "rotate_ccw = 当前向右倒了 90°，需要逆时针旋转 90° 矫正。"
    "rotate_180 = 上下颠倒，需要旋转 180°。"
)

VALID_AI_DECISIONS = {"correct", "rotate_cw", "rotate_ccw", "rotate_180"}


def _fix_exif_orientation(img: PILImage.Image) -> tuple[PILImage.Image, bool]:
    """Apply EXIF orientation tag and strip it. Returns (image, was_rotated)."""
    try:
        original_size = img.size
        img = ImageOps.exif_transpose(img)
        rotated = img.size != original_size
        return img, rotated
    except Exception:
        return img, False


# ── Lossless rotation (writes to derived/, never touches original) ──────────

# EXIF Orientation tag → jpegtran op. Source of truth: libjpeg-turbo docs.
_EXIF_TO_JPEGTRAN = {
    2: ["-flip", "horizontal"],
    3: ["-rotate", "180"],
    4: ["-flip", "vertical"],
    5: ["-transpose"],
    6: ["-rotate", "90"],
    7: ["-transverse"],
    8: ["-rotate", "270"],
}

# Map our rotate_cw/ccw/180 directives to jpegtran args + PIL counter-clockwise
# degrees (both kept so we can pick the right path depending on input format).
_DIRECTIVE_TO_JPEGTRAN = {
    "rotate_cw":  ["-rotate", "90"],
    "rotate_ccw": ["-rotate", "270"],
    "rotate_180": ["-rotate", "180"],
}

_JPEGTRAN_BIN: str | None = shutil.which("jpegtran")


def _derived_path(image_id: str, src_path: str) -> Path:
    """Stable per-image path for the rotated derivative. Preserves the
    source's extension so jpegtran / PIL both write the native format."""
    ext = Path(src_path).suffix.lower() or ".jpg"
    subdir = DERIVED_DIR / "orient" / image_id[:2]
    subdir.mkdir(parents=True, exist_ok=True)
    return subdir / f"{image_id}{ext}"


def _read_exif_orientation(path: str) -> int:
    """Return raw EXIF Orientation tag (1..8), or 1 if missing/unreadable."""
    try:
        with PILImage.open(path) as im:
            exif = im.getexif()
            return int(exif.get(0x0112, 1) or 1)
    except Exception:
        return 1


def _lossless_jpeg_rotate(src: str, dst: Path, jpegtran_args: list[str]) -> bool:
    """Run jpegtran with -perfect -copy all. Returns True on success.

    -perfect refuses to rotate when the result would be non-reversible (e.g.
    image dimensions not a multiple of the MCU block). We trim those edges
    off rather than silently skipping — that's what -trim is for.
    """
    if not _JPEGTRAN_BIN:
        return False
    try:
        result = subprocess.run(
            [_JPEGTRAN_BIN, "-copy", "all", "-trim", *jpegtran_args, "-outfile", str(dst), src],
            capture_output=True, timeout=30,
        )
        if result.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            return True
        logger.warning("jpegtran failed for %s: rc=%d stderr=%s",
                       src, result.returncode, result.stderr[:200].decode(errors="replace"))
    except Exception as e:
        logger.warning("jpegtran invocation failed for %s: %s", src, e)
    # Cleanup partial output if jpegtran wrote something unusable
    if dst.exists():
        try: dst.unlink()
        except OSError: pass
    return False


def _pil_lossless_rotate(src_img: PILImage.Image, degrees: int, dst: Path, src_format: str) -> None:
    """Rotate in PIL and save back in the source format with the most
    conservative (highest-fidelity) encoder settings available.

    - PNG / TIFF / BMP → native lossless
    - WebP → lossless=True
    - JPEG (fallback when jpegtran unavailable) → quality=100, subsampling=0,
      qtables='keep' only applies when re-encoding same JPEG; PIL doesn't
      support qtables here so we settle for max-fidelity encode.
    - HEIC / HEIF → writable via pillow_heif; we save as lossless quality=-1
      if supported, else fall back to PNG preserving pixels (extension hint).
    """
    img = src_img.rotate(degrees, expand=True)
    fmt = (src_format or "").upper()

    if fmt == "JPEG":
        # Max fidelity JPEG. Still technically lossy but only the fallback
        # when jpegtran isn't available.
        save_img = img.convert("RGB") if img.mode in ("RGBA", "P", "LA") else img
        save_img.save(dst, "JPEG", quality=100, subsampling=0, optimize=False,
                      exif=src_img.info.get("exif", b""),
                      icc_profile=src_img.info.get("icc_profile"))
    elif fmt == "PNG":
        img.save(dst, "PNG", compress_level=6,
                 icc_profile=src_img.info.get("icc_profile"))
    elif fmt == "WEBP":
        img.save(dst, "WEBP", lossless=True, quality=100,
                 icc_profile=src_img.info.get("icc_profile"))
    elif fmt in ("TIFF", "BMP"):
        img.save(dst, fmt)
    else:
        # Unknown / HEIC — PIL writing HEIC needs pillow_heif >= 0.x;
        # safest is PNG to keep pixels intact. Rename extension.
        dst_png = dst.with_suffix(".png")
        img.save(dst_png, "PNG", compress_level=6)
        if dst_png != dst:
            # replace so caller's recorded path matches on-disk
            try: dst.unlink(missing_ok=True)
            except Exception: pass
            dst_png.replace(dst)


def _apply_lossless_rotation(
    image_id: str,
    src_path: str,
    *,
    directive: str | None = None,
    exif_orientation: int | None = None,
) -> tuple[Path, tuple[int, int]] | None:
    """Produce a rotated copy at the derived path.

    Pass exactly one of `directive` (rotate_cw|rotate_ccw|rotate_180) or
    `exif_orientation` (EXIF tag value 2..8 — 1 is a no-op).

    Returns (derived_path, (width, height)) on success; None on no-op/failure.
    """
    dst = _derived_path(image_id, src_path)

    # Decide jpegtran args
    if directive:
        jtran_args = _DIRECTIVE_TO_JPEGTRAN.get(directive)
        pil_degrees = {"rotate_cw": 270, "rotate_ccw": 90, "rotate_180": 180}.get(directive)
    elif exif_orientation and 2 <= exif_orientation <= 8:
        jtran_args = _EXIF_TO_JPEGTRAN.get(exif_orientation)
        pil_degrees = None  # EXIF handled via PIL ImageOps.exif_transpose fallback
    else:
        return None

    src_ext = Path(src_path).suffix.lower()

    # JPEG fast path: jpegtran is byte-perfect reversible (with -perfect) and
    # preserves EXIF/ICC via -copy all.
    if src_ext in (".jpg", ".jpeg") and jtran_args and _lossless_jpeg_rotate(src_path, dst, jtran_args):
        try:
            with PILImage.open(dst) as im:
                return dst, im.size
        except Exception as e:
            logger.warning("jpegtran output unreadable for %s: %s", src_path, e)

    # Non-JPEG or jpegtran fallback → PIL. Strictly lossless for PNG/WebP/TIFF;
    # max-fidelity for JPEG.
    try:
        with PILImage.open(src_path) as src_img:
            src_format = src_img.format or ""
            if directive:
                _pil_lossless_rotate(src_img, pil_degrees, dst, src_format)
            else:
                # EXIF pass via PIL (handles all 8 orientations including flips)
                corrected = ImageOps.exif_transpose(src_img)
                save_img = corrected
                fmt = src_format.upper()
                if fmt == "JPEG":
                    save_img = save_img.convert("RGB") if save_img.mode in ("RGBA", "P", "LA") else save_img
                    save_img.save(dst, "JPEG", quality=100, subsampling=0, optimize=False,
                                  icc_profile=src_img.info.get("icc_profile"))
                elif fmt == "PNG":
                    save_img.save(dst, "PNG", compress_level=6, icc_profile=src_img.info.get("icc_profile"))
                elif fmt == "WEBP":
                    save_img.save(dst, "WEBP", lossless=True, quality=100,
                                  icc_profile=src_img.info.get("icc_profile"))
                elif fmt in ("TIFF", "BMP"):
                    save_img.save(dst, fmt)
                else:
                    dst = dst.with_suffix(".png")
                    save_img.save(dst, "PNG", compress_level=6)
            with PILImage.open(dst) as out:
                return dst, out.size
    except Exception as e:
        logger.error("Lossless rotate failed for %s: %s", src_path, e)
        return None


# ── AI orientation classifier ──────────────────────────────────────────────


async def _ai_decide_orientation(image_path: str) -> str | None:
    """Returns 'correct'/'rotate_cw'/'rotate_ccw'/'rotate_180' or None on failure."""
    try:
        target = get_general_provider_target()
    except Exception as e:
        logger.info("AI orient skipped (no general provider): %s", e)
        return None

    # Downscale before sending — 512px is plenty for orientation classification
    try:
        with PILImage.open(image_path) as raw:
            img = raw.convert("RGB")
            img.thumbnail((512, 512))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=75)
            b64 = base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        logger.warning("AI orient: could not load %s: %s", image_path, e)
        return None

    if target["type"] == "openai_compat":
        return await _ai_decide_via_openai_compat(target, b64)
    if target["type"] == "gemini":
        return await _ai_decide_via_gemini(target, b64)
    return None


async def _ai_decide_via_openai_compat(target: dict, b64: str) -> str | None:
    import httpx
    base = target["base_url"].rstrip("/")
    if not base.endswith("/v1"):
        base = base + "/v1"
    url = base + "/chat/completions"
    headers = {"Authorization": f"Bearer {target['api_key']}", "Content-Type": "application/json"}
    body = {
        "model": target.get("model") or "gpt-4o-mini",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": AI_INSTRUCTION},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ],
        }],
        "temperature": 0.0,
        "max_tokens": 10,
    }
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, headers=headers, json=body)
            resp.raise_for_status()
            content = (resp.json()["choices"][0]["message"]["content"] or "").strip().lower()
    except Exception as e:
        logger.warning("AI orient OpenAI-compat call failed: %s", e)
        return None
    return _parse_ai_decision(content)


async def _ai_decide_via_gemini(target: dict, b64: str) -> str | None:
    try:
        import google.generativeai as genai
        genai.configure(api_key=target["api_key"])
        model = genai.GenerativeModel(target.get("model") or "gemini-2.0-flash")
        resp = await model.generate_content_async([
            AI_INSTRUCTION,
            {"mime_type": "image/jpeg", "data": base64.b64decode(b64)},
        ])
        content = (getattr(resp, "text", "") or "").strip().lower()
    except Exception as e:
        logger.warning("AI orient Gemini call failed: %s", e)
        return None
    return _parse_ai_decision(content)


def _parse_ai_decision(raw: str) -> str | None:
    if not raw:
        return None
    for candidate in VALID_AI_DECISIONS:
        if candidate in raw:
            return candidate
    return None


# ── Engine ─────────────────────────────────────────────────────────────────


async def run_orient(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    mode = params.get("mode", "auto")  # auto | auto+ai | rotate_cw | rotate_ccw | rotate_180
    image_ids = params.get("image_ids", [])
    max_ai_images = int(params.get("max_ai_images", 500))

    async with async_session() as db:
        if image_ids:
            result = await db.execute(select(Image).where(Image.id.in_(image_ids)))
        else:
            result = await db.execute(
                select(Image).where(
                    Image.project_id == task.project_id,
                    Image.quality_status.in_(["pending", "passed"]),
                )
            )
        images = result.scalars().all()
        total = len(images)

        fixed = 0
        skipped = 0
        ai_calls = 0
        await progress_cb(total=total, processed=0, fixed=0, skipped=0)

        for idx, img_record in enumerate(images):
            try:
                src_path = img_record.file_path

                if mode in ("rotate_cw", "rotate_ccw", "rotate_180"):
                    # Manual rotation — always applies
                    res = _apply_lossless_rotation(img_record.id, src_path, directive=mode)
                    if res:
                        dst, (new_w, new_h) = res
                        await db.execute(
                            update(Image).where(Image.id == img_record.id).values(
                                width=new_w, height=new_h, orient_status="manual",
                                rotated_file_path=str(dst),
                            )
                        )
                        invalidate_thumbnails(img_record.id, THUMBNAILS_DIR)
                        fixed += 1
                    else:
                        skipped += 1
                else:
                    # Auto: check EXIF Orientation tag first (no decode needed)
                    exif_orient = _read_exif_orientation(src_path)
                    if exif_orient != 1:
                        res = _apply_lossless_rotation(img_record.id, src_path, exif_orientation=exif_orient)
                        if res:
                            dst, (new_w, new_h) = res
                            await db.execute(
                                update(Image).where(Image.id == img_record.id).values(
                                    width=new_w, height=new_h, orient_status="exif",
                                    rotated_file_path=str(dst),
                                )
                            )
                            invalidate_thumbnails(img_record.id, THUMBNAILS_DIR)
                            fixed += 1
                        else:
                            skipped += 1
                    elif mode == "auto+ai" and ai_calls < max_ai_images and (
                        # Explicit re-run on selected images bypasses the
                        # "already-decided" gate so the user can redo a
                        # previously-skipped or AI-corrected image.
                        bool(image_ids)
                        or img_record.orient_status not in ("ai", "manual", "skipped")
                    ):
                        ai_calls += 1
                        decision = await _ai_decide_orientation(src_path)
                        if decision in _ROTATION_BY_DEGREES:
                            res = _apply_lossless_rotation(img_record.id, src_path, directive=decision)
                            if res:
                                dst, (new_w, new_h) = res
                                await db.execute(
                                    update(Image).where(Image.id == img_record.id).values(
                                        width=new_w, height=new_h, orient_status="ai",
                                        rotated_file_path=str(dst),
                                    )
                                )
                                invalidate_thumbnails(img_record.id, THUMBNAILS_DIR)
                                fixed += 1
                            else:
                                skipped += 1
                        elif decision == "correct":
                            await db.execute(
                                update(Image).where(Image.id == img_record.id).values(orient_status="skipped")
                            )
                            skipped += 1
                        else:
                            # AI failed — mark skipped so we don't retry next run (costs money)
                            await db.execute(
                                update(Image).where(Image.id == img_record.id).values(orient_status="skipped")
                            )
                            skipped += 1
                    else:
                        skipped += 1

            except Exception as e:
                logger.error("Orient failed for %s: %s", img_record.id, e)
                skipped += 1

            if (idx + 1) % 20 == 0 or idx == total - 1:
                await db.commit()
                await progress_cb(
                    processed=idx + 1, total=total,
                    fixed=fixed, skipped=skipped, ai_calls=ai_calls,
                )

        await db.commit()
        logger.info(
            "Orient done: mode=%s fixed=%d skipped=%d ai_calls=%d total=%d",
            mode, fixed, skipped, ai_calls, total,
        )
