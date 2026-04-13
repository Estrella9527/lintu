"""Scan a directory and import images into the database."""

import hashlib
import json
import logging
from pathlib import Path

from PIL import Image as PILImage
from sqlalchemy import select

from sidecar.db.models import Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"}


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
                )
                db.add(img)
                existing_hashes.add(file_hash)
                imported += 1

            if (idx + 1) % 20 == 0 or idx == len(files) - 1:
                await db.commit()
                await progress_cb(
                    processed=idx + 1,
                    total=len(files),
                    imported=imported,
                    skipped=skipped,
                )

        await db.commit()
        logger.info(f"Scan complete: {imported} imported, {skipped} skipped")
