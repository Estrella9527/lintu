"""One-shot backfill: compute pHash + dHash + aHash for every image whose
`phash` column is NULL. Run after upgrading scan.py to auto-hash on import.

Usage:
    cd apps/sidecar
    uv run python scripts/backfill_phashes.py

Safe to interrupt and re-run — only hashes images still missing phash.
Writes in batches of 50 with short sessions to avoid long-held SQLite write
locks (so the running sidecar / batch_scheduler stays responsive).
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from pathlib import Path

from sqlalchemy import select, update

# Allow running as a script
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sidecar.db.models import Image  # noqa: E402
from sidecar.db.session import async_session  # noqa: E402
from sidecar.engines.image_utils import compute_perceptual_hashes  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("backfill")

BATCH_SIZE = 50


async def main() -> None:
    # First pass: count how many need hashing
    async with async_session() as db:
        rows = (await db.execute(
            select(Image.id, Image.file_path).where(Image.phash.is_(None))
        )).all()
    todo = [(r[0], r[1]) for r in rows]
    logger.info("Found %d images missing phash", len(todo))
    if not todo:
        logger.info("Nothing to do.")
        return

    started = time.time()
    done = 0
    failed = 0
    pending: list[tuple[str, str]] = []

    async def flush() -> None:
        if not pending:
            return
        async with async_session() as db:
            for img_id, phash_json in pending:
                await db.execute(
                    update(Image).where(Image.id == img_id).values(phash=phash_json)
                )
            await db.commit()
        pending.clear()

    for img_id, file_path in todo:
        try:
            triple = compute_perceptual_hashes(file_path)
        except Exception as e:
            logger.warning("hash failed for %s: %s", file_path, e)
            triple = None

        if triple:
            pending.append((img_id, json.dumps(triple)))
        else:
            failed += 1
        done += 1

        if len(pending) >= BATCH_SIZE:
            await flush()
            elapsed = time.time() - started
            rate = done / elapsed if elapsed else 0
            remaining = len(todo) - done
            eta_min = (remaining / rate / 60) if rate else 0
            logger.info(
                "progress: %d / %d  (%.1f img/s, %d failed, ETA %.1f min)",
                done, len(todo), rate, failed, eta_min,
            )

    await flush()
    logger.info("Done. %d hashed, %d failed in %.1fs", done - failed, failed, time.time() - started)


if __name__ == "__main__":
    asyncio.run(main())
