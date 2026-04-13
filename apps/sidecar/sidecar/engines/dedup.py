"""Deduplication engine: pHash-based duplicate detection."""

import json
import logging
from collections import defaultdict

import imagehash
from PIL import Image as PILImage
from sqlalchemy import select, update

from sidecar.db.models import DuplicateGroup, Image, Task
from sidecar.db.session import async_session

logger = logging.getLogger(__name__)


def _compute_phash(path: str) -> str:
    try:
        img = PILImage.open(path)
        return str(imagehash.phash(img))
    except Exception:
        return ""


def _hamming_distance(h1: str, h2: str) -> int:
    if not h1 or not h2 or len(h1) != len(h2):
        return 999
    return sum(c1 != c2 for c1, c2 in zip(h1, h2))


async def run_dedup(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    threshold = params.get("threshold", 10)

    async with async_session() as db:
        # Get passed images (only dedup seeds that passed quality check)
        result = await db.execute(
            select(Image)
            .where(Image.project_id == task.project_id)
            .where(Image.quality_status == "passed")
            .where(Image.is_kept == True)  # noqa: E712
        )
        images = result.scalars().all()
        total = len(images)

        # Phase 1: Compute pHash for images missing it
        await progress_cb(total=total * 2, processed=0, phase="hashing")
        for idx, img in enumerate(images):
            if not img.phash:
                phash = _compute_phash(img.file_path)
                await db.execute(
                    update(Image).where(Image.id == img.id).values(phash=phash)
                )
                img.phash = phash

            if (idx + 1) % 50 == 0:
                await db.commit()
                await progress_cb(processed=idx + 1, total=total * 2, phase="hashing")

        await db.commit()
        await progress_cb(processed=total, total=total * 2, phase="grouping")

        # Phase 2: Find duplicate groups via brute-force comparison
        # For large datasets this should use VP-tree; for Phase 1 brute force is ok
        assigned = set()
        groups = []

        for i, img_a in enumerate(images):
            if img_a.id in assigned or not img_a.phash:
                continue
            group = [img_a]
            for j in range(i + 1, len(images)):
                img_b = images[j]
                if img_b.id in assigned or not img_b.phash:
                    continue
                dist = _hamming_distance(img_a.phash, img_b.phash)
                if dist <= threshold:
                    group.append(img_b)
                    assigned.add(img_b.id)

            if len(group) > 1:
                assigned.add(img_a.id)
                groups.append(group)

            if (i + 1) % 100 == 0:
                await progress_cb(
                    processed=total + i + 1, total=total * 2, phase="grouping"
                )

        # Save groups and mark kept/discarded
        for group in groups:
            # Pick best: highest blur_score (sharpest)
            best = max(group, key=lambda im: (im.blur_score or 0))
            avg_dist = 0

            dup_group = DuplicateGroup(
                project_id=task.project_id,
                kept_image_id=best.id,
                image_count=len(group),
                avg_hamming_distance=avg_dist,
            )
            db.add(dup_group)
            await db.flush()

            for img in group:
                await db.execute(
                    update(Image)
                    .where(Image.id == img.id)
                    .values(
                        dedup_group_id=dup_group.id,
                        is_kept=(img.id == best.id),
                    )
                )

        await db.commit()
        await progress_cb(processed=total * 2, total=total * 2, phase="done")
        logger.info(f"Dedup done: {len(groups)} duplicate groups found")
