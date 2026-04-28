"""Scan a directory and import images into the database."""

import hashlib
import json
import logging
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.defaults import get_setting
from sidecar.engines.image_utils import compute_perceptual_hashes
from sidecar.engines.oss_sync import enqueue_image_sync

logger = logging.getLogger(__name__)

# Register HEIC support if available
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass


def _get_supported_formats() -> set:
    raw = get_setting("quality_supported_formats") or ".jpg,.jpeg,.png,.webp,.heic,.bmp,.tiff,.tif"
    return {ext.strip().lower() for ext in raw.split(",") if ext.strip()}


IMAGE_EXTENSIONS = _get_supported_formats()


def _md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _image_info(path: Path) -> dict:
    """Get basic image metadata without loading full pixels."""
    try:
        with PILImage.open(path) as img:
            w, h = img.size
        size_kb = path.stat().st_size // 1024
        return {"width": w, "height": h, "file_size_kb": size_kb}
    except Exception:
        return {"width": 0, "height": 0, "file_size_kb": 0}


async def run_scan(task: Task, progress_cb):
    """Scan a directory and register all images into DB."""
    params = json.loads(task.parameters or "{}")
    directory = Path(params.get("directory", ""))

    if not directory.is_dir():
        raise ValueError(f"Directory does not exist: {directory}")

    # Collect image files
    files = sorted(
        f for f in directory.rglob("*") if f.suffix.lower() in IMAGE_EXTENSIONS and f.is_file()
    )

    await progress_cb(total=len(files), processed=0, phase="scanning")

    async with async_session() as db:
        # Get existing hashes for this project to skip duplicates
        result = await db.execute(
            select(Image.file_hash).where(Image.project_id == task.project_id)
        )
        existing_hashes = {row[0] for row in result if row[0]}

        imported = 0
        skipped = 0

        for idx, fpath in enumerate(files):
            file_hash = _md5(fpath)

            if file_hash in existing_hashes:
                skipped += 1
            else:
                info = _image_info(fpath)
                try:
                    rel_dir = str(fpath.parent.relative_to(directory))
                except ValueError:
                    rel_dir = ""
                if rel_dir == ".":
                    rel_dir = ""
                # Pre-compute perceptual hashes during ingest so dedup never
                # has to do a 7000-image hashing phase under a long write lock.
                # Adds ~50-100ms per image; one-time cost amortized at import.
                phash_dict = compute_perceptual_hashes(fpath)
                img = Image(
                    project_id=task.project_id,
                    file_path=str(fpath),
                    file_name=fpath.name,
                    file_hash=file_hash,
                    width=info["width"],
                    height=info["height"],
                    file_size_kb=info["file_size_kb"],
                    quality_status="pending",
                    tag_status="pending",
                    source_type="original",
                    relative_dir=rel_dir,
                    phash=json.dumps(phash_dict) if phash_dict else None,
                )
                db.add(img)
                existing_hashes.add(file_hash)
                imported += 1
                # Stash for post-commit OSS enqueue (need the id, set after flush)
                if "newly_added" not in locals():
                    newly_added = []
                newly_added.append(img)

            if (idx + 1) % 20 == 0 or idx == len(files) - 1:
                await db.flush()
                added_ids = [im.id for im in (newly_added if "newly_added" in locals() else [])]
                await db.commit()
                # Enqueue OSS sync for the freshly-committed images. No-op when
                # OSS is disabled. Best-effort: any failure is logged, scan
                # itself never blocks on the queue.
                for iid in added_ids:
                    try:
                        await enqueue_image_sync(iid)
                    except Exception as e:
                        logger.debug("oss enqueue (scan) failed for %s: %s", iid, e)
                newly_added = []
                await progress_cb(
                    processed=idx + 1,
                    total=len(files),
                    imported=imported,
                    skipped=skipped,
                )

        await db.commit()
        logger.info(f"Scan complete: {imported} imported, {skipped} skipped")
