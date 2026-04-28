"""Populate Image.text_search_blob for every existing row.

Run:  cd apps/sidecar && uv run python scripts/backfill_text_search.py

Idempotent — re-running just refreshes blobs to the latest tag/description
state. Safe to run on a live DB.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select, update

from sidecar.db.models import Image, Tag
from sidecar.db.session import async_session


def build_blob(file_name: str, description: str | None, tag_values: list[str]) -> str:
    parts: list[str] = []
    if file_name:
        # strip extension noise — DJI_xxx.jpg → DJI_xxx
        stem = Path(file_name).stem
        parts.append(stem.replace("_", " "))
    if description and description.strip():
        parts.append(description.strip())
    if tag_values:
        parts.append(", ".join(tag_values))
    return "\n".join(parts)


async def main() -> None:
    BATCH = 500
    offset = 0
    total_updated = 0

    while True:
        async with async_session() as db:
            rows = await db.execute(
                select(Image.id, Image.file_name, Image.description)
                .order_by(Image.id)
                .offset(offset)
                .limit(BATCH)
            )
            chunk = rows.all()
            if not chunk:
                break

            ids = [r[0] for r in chunk]
            tag_rows = await db.execute(
                select(Tag.image_id, Tag.value).where(Tag.image_id.in_(ids))
            )
            tags_by_img: dict[str, list[str]] = {}
            for img_id, val in tag_rows.all():
                tags_by_img.setdefault(img_id, []).append(val)

            for img_id, file_name, description in chunk:
                blob = build_blob(file_name or "", description, tags_by_img.get(img_id, []))
                await db.execute(
                    update(Image).where(Image.id == img_id).values(text_search_blob=blob)
                )
            await db.commit()
            total_updated += len(chunk)
            print(f"backfilled {total_updated} so far...")
            offset += BATCH

    print(f"done. total: {total_updated} images.")


if __name__ == "__main__":
    asyncio.run(main())
