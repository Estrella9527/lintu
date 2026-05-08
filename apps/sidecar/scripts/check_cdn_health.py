"""Periodic OSS / CDN reachability scan.

Walks every Image row that has a `cdn_path`, HEADs both the original URL and
the 300px thumbnail URL, and reports which ones are broken (4xx / 5xx /
network error). Designed to run on the cloud sidecar against the PG that
serves UGC matches — those are the URLs that show up in the public response.

Usage:
    cd apps/sidecar

    # Dry-run — only report.
    uv run python scripts/check_cdn_health.py

    # Limit scope to one project, raise concurrency for large bucket scans.
    uv run python scripts/check_cdn_health.py --project-id 4709929c... --concurrency 32

    # Auto-remediate: clear cdn_path on broken originals so the matcher's
    # cdn_required filter stops returning them. Operators then re-trigger
    # sync from the desktop sidecar (which holds the source files).
    uv run python scripts/check_cdn_health.py --clear-broken-originals

Cron suggestion (weekly, 03:30 Sunday):
    30 3 * * 0  cd /opt/lintu/apps/sidecar && /usr/local/bin/uv run python \\
        scripts/check_cdn_health.py >> /var/log/lintu/cdn_health.log 2>&1

Idempotent and read-only by default. The --clear-broken-originals path
performs a scoped UPDATE (cdn_path = NULL where id IN (...)); rerunning
afterwards finds those rows already have cdn_path = NULL and skips them.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402
from sqlalchemy import select, update  # noqa: E402

from sidecar.db.models import Image  # noqa: E402
from sidecar.db.session import async_session  # noqa: E402
from sidecar.engines.oss_sync import get_storage, object_key_for  # noqa: E402


async def _head(client: httpx.AsyncClient, url: str) -> tuple[int, str]:
    """Return (status_code, error_str). status_code=0 means transport error."""
    try:
        # Some CDNs reject HEAD; fall back to a 1-byte ranged GET on 405.
        r = await client.head(url, follow_redirects=True)
        if r.status_code == 405:
            r = await client.get(url, headers={"Range": "bytes=0-0"}, follow_redirects=True)
        return r.status_code, ""
    except httpx.RequestError as e:
        return 0, type(e).__name__ + ": " + str(e)[:80]


async def _check_one(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    image_id: str,
    cdn_path: str,
    storage,
) -> dict:
    original_url = storage.public_url(cdn_path)
    thumb_url = storage.public_url(object_key_for(image_id, "thumb_300", "jpg"))

    async with sem:
        orig_status, orig_err = await _head(client, original_url)
        thumb_status, thumb_err = await _head(client, thumb_url)

    return {
        "image_id": image_id,
        "cdn_path": cdn_path,
        "original_url": original_url,
        "original_status": orig_status,
        "original_error": orig_err,
        "thumbnail_url": thumb_url,
        "thumbnail_status": thumb_status,
        "thumbnail_error": thumb_err,
    }


def _is_broken(status: int) -> bool:
    """Network error (0) or any non-success / non-redirect HTTP status."""
    if status == 0:
        return True
    return status >= 400


async def _load_targets(project_id: str | None, limit: int | None) -> list[tuple[str, str]]:
    async with async_session() as db:
        q = select(Image.id, Image.cdn_path).where(
            Image.cdn_path.is_not(None),
            Image.cdn_path != "",
        )
        if project_id:
            q = q.where(Image.project_id == project_id)
        q = q.order_by(Image.created_at.desc())
        if limit:
            q = q.limit(limit)
        rows = await db.execute(q)
    return [(r[0], r[1]) for r in rows.all()]


async def _clear_originals(image_ids: list[str]) -> int:
    if not image_ids:
        return 0
    async with async_session() as db:
        result = await db.execute(
            update(Image).where(Image.id.in_(image_ids)).values(cdn_path=None)
        )
        await db.commit()
    return result.rowcount or 0


async def _amain() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-id", default=None,
                        help="Limit to a single project's images")
    parser.add_argument("--limit", type=int, default=None,
                        help="Cap how many rows to check (for spot-checks)")
    parser.add_argument("--concurrency", type=int, default=16,
                        help="Parallel HEAD requests (default: 16)")
    parser.add_argument("--timeout", type=float, default=8.0,
                        help="Per-request timeout in seconds (default: 8.0)")
    parser.add_argument("--clear-broken-originals", action="store_true",
                        help="UPDATE cdn_path = NULL on rows whose original URL is broken. "
                             "The matcher's cdn_required filter will then exclude them.")
    args = parser.parse_args()

    storage = get_storage()
    if not storage.is_read_configured():
        print("ERROR: OSS / CDN is not configured (storage.is_read_configured() = False)",
              file=sys.stderr)
        return 2

    targets = await _load_targets(args.project_id, args.limit)
    print(f"checking {len(targets)} images "
          f"(project_id={args.project_id or 'ALL'}, concurrency={args.concurrency})")
    if not targets:
        print("nothing to check.")
        return 0

    sem = asyncio.Semaphore(args.concurrency)
    results: list[dict] = []
    started = time.perf_counter()

    async with httpx.AsyncClient(timeout=args.timeout) as client:
        coros = [
            _check_one(client, sem, iid, cdn_path, storage)
            for iid, cdn_path in targets
        ]
        for i, fut in enumerate(asyncio.as_completed(coros), start=1):
            row = await fut
            results.append(row)
            if i % 100 == 0:
                print(f"  [{i}/{len(targets)}] checked", flush=True)

    took = time.perf_counter() - started

    broken_orig = [r for r in results if _is_broken(r["original_status"])]
    broken_thumb = [r for r in results if _is_broken(r["thumbnail_status"])]
    both = [r for r in results
            if _is_broken(r["original_status"]) and _is_broken(r["thumbnail_status"])]

    print()
    print(f"=== CDN health summary ({took:.1f}s) ===")
    print(f"  total checked      : {len(results)}")
    print(f"  broken original    : {len(broken_orig)} "
          f"({len(broken_orig) / len(results) * 100:.2f}%)")
    print(f"  broken thumbnail   : {len(broken_thumb)} "
          f"({len(broken_thumb) / len(results) * 100:.2f}%)")
    print(f"  broken both        : {len(both)}")

    if broken_orig:
        print("\n--- broken originals (sample) ---")
        for r in broken_orig[:20]:
            err = r["original_error"] or f"http {r['original_status']}"
            print(f"  {r['image_id']}  {err}  {r['original_url']}")
        if len(broken_orig) > 20:
            print(f"  ... and {len(broken_orig) - 20} more")

    if broken_thumb and not args.clear_broken_originals:
        print("\n--- broken thumbnails (sample) ---")
        for r in broken_thumb[:20]:
            err = r["thumbnail_error"] or f"http {r['thumbnail_status']}"
            print(f"  {r['image_id']}  {err}  {r['thumbnail_url']}")
        if len(broken_thumb) > 20:
            print(f"  ... and {len(broken_thumb) - 20} more")

    if args.clear_broken_originals:
        ids = [r["image_id"] for r in broken_orig]
        if not ids:
            print("\nno broken originals to clear.")
        else:
            n = await _clear_originals(ids)
            print(f"\ncleared cdn_path on {n} rows. "
                  f"matcher will now treat these as 'not synced' until re-uploaded.")

    return 0


def main() -> int:
    return asyncio.run(_amain())


if __name__ == "__main__":
    raise SystemExit(main())
