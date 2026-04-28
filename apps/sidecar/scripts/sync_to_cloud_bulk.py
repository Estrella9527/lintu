"""One-shot bulk sync: push the entire local DB to a freshly deployed
cloud sidecar.

Use when:
  - Cloud is just stood up (empty PG)
  - You suspect drift and want to refresh everything
  - Embedding model changed, so all vectors need re-pushing

Usage:
    cd apps/sidecar
    LINTU_CLOUD_SYNC_URL=https://api.your-domain.com \\
    LINTU_INTERNAL_SYNC_TOKEN=... \\
        uv run python scripts/sync_to_cloud_bulk.py

Idempotent — running twice gives the same end state. Safe to interrupt
mid-flight; just re-run.

This script intentionally does NOT use cloud_sync_worker's queue table
(cloud_sync_jobs). It pushes synchronously in chunks, prints progress,
and exits. The queue is for ongoing incremental sync; this is for the
initial firehose.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

# Allow running from repo root: python apps/sidecar/scripts/sync_to_cloud_bulk.py
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

from sidecar.config import LINTU_CLOUD_SYNC_URL, LINTU_INTERNAL_SYNC_TOKEN  # noqa: E402
from sidecar.db.models import ApiKey, Image, Project, Tag  # noqa: E402
from sidecar.db.session import async_session  # noqa: E402
from sqlalchemy import select  # noqa: E402


CHUNK_SIZE = 100   # images per HTTP call
TIMEOUT = httpx.Timeout(connect=10, read=120, write=120, pool=10)


async def _post(client: httpx.AsyncClient, path: str, payload: dict) -> dict:
    resp = await client.post(f"{LINTU_CLOUD_SYNC_URL.rstrip('/')}{path}", json=payload)
    if resp.status_code >= 400:
        raise RuntimeError(f"{path} HTTP {resp.status_code}: {resp.text[:300]}")
    return resp.json()


async def push_projects(client: httpx.AsyncClient) -> int:
    async with async_session() as db:
        rows = (await db.execute(select(Project))).scalars().all()
    if not rows:
        return 0
    payload = {"projects": [
        {
            "id": p.id, "name": p.name,
            "originals_path": p.originals_path,
            "workspace_path": p.workspace_path,
            "color": p.color,
        } for p in rows
    ]}
    r = await _post(client, "/internal/sync/projects", payload)
    return r.get("upserted", len(rows))


async def push_api_keys(client: httpx.AsyncClient) -> int:
    async with async_session() as db:
        rows = (await db.execute(select(ApiKey))).scalars().all()
    if not rows:
        return 0
    payload = {"api_keys": [
        {
            "id": k.id,
            "key_id": k.key_id,
            "key_secret_hash": k.key_secret_hash,
            "name": k.name,
            "client_type": k.client_type,
            "allowed_origins": k.allowed_origins,
            "allowed_ips": k.allowed_ips,
            "scopes": k.scopes,
            "rate_limit": k.rate_limit,
            "expires_at": k.expires_at.isoformat() if k.expires_at else None,
            "is_active": k.is_active,
        } for k in rows
    ]}
    r = await _post(client, "/internal/sync/api-keys", payload)
    return r.get("upserted", len(rows))


async def push_images(client: httpx.AsyncClient) -> int:
    """Stream images in chunks. Loads all rows of a chunk at once (with their
    tags) to keep the per-call payload self-contained."""
    from sidecar.engines.clip_embed import deserialize_vector
    total_pushed = 0
    async with async_session() as db:
        # Originals first, then generated. Image.parent_id has a FK to images.id,
        # so children must arrive after their parents — otherwise the cloud's
        # PostgreSQL rejects the row with a 500.
        all_ids = [r[0] for r in (await db.execute(
            select(Image.id).order_by(
                (Image.source_type != "original"),  # False (=original) sorts first
                Image.id,
            )
        )).all()]
    # Set of original IDs only — these are the only parent_ids guaranteed to
    # already be in the cloud when we push generated rows (originals are
    # ordered first). For multi-generation chains (gen → gen) and orphans,
    # we sanitize parent_id to NULL: cloud doesn't need the lineage graph,
    # and keeping it would require a full topological sort of the generated
    # subset, which isn't worth ~30 rows of lineage info.
    async with async_session() as db:
        valid_id_set = set((await db.execute(
            select(Image.id).where(Image.source_type == "original")
        )).scalars().all())
    total = len(all_ids)
    if total == 0:
        return 0
    started = time.perf_counter()
    for i in range(0, total, CHUNK_SIZE):
        chunk_ids = all_ids[i:i + CHUNK_SIZE]
        async with async_session() as db:
            imgs = (await db.execute(select(Image).where(Image.id.in_(chunk_ids)))).scalars().all()
            tag_rows = (await db.execute(
                select(Tag.image_id, Tag.dimension, Tag.value, Tag.source, Tag.confidence)
                .where(Tag.image_id.in_(chunk_ids))
            )).all()
        tags_by_img: dict[str, list] = {}
        for img_id, dim, val, src, conf in tag_rows:
            tags_by_img.setdefault(img_id, []).append({
                "dimension": dim, "value": val, "source": src, "confidence": conf,
            })

        payload_images = []
        for img in imgs:
            # Embedding is base64-float16 text (clip_embed format); decode to
            # float32 list for transport. None on un-embedded rows.
            emb_arr = deserialize_vector(img.embedding) if img.embedding else None
            emb = emb_arr.tolist() if emb_arr is not None else None
            payload_images.append({
                "id": img.id,
                "project_id": img.project_id,
                "file_path": img.file_path,
                "file_name": img.file_name,
                "file_hash": img.file_hash,
                "phash": img.phash,
                "file_size_kb": img.file_size_kb,
                "width": img.width,
                "height": img.height,
                "blur_score": img.blur_score,
                "brightness": img.brightness,
                "quality_status": img.quality_status,
                "reject_reason": img.reject_reason,
                "is_kept": img.is_kept,
                "tag_status": img.tag_status,
                "description": img.description,
                "source_type": img.source_type,
                "relative_dir": img.relative_dir,
                "parent_id": img.parent_id if (img.parent_id is None or img.parent_id in valid_id_set) else None,
                "rotated_file_path": img.rotated_file_path,
                "orient_status": img.orient_status,
                "cdn_path": img.cdn_path,
                "embedding": emb,
                "embedding_model": img.embedding_model,
                "text_search_blob": img.text_search_blob,
                "generation_metadata": img.generation_metadata,
                "tagged_at": img.tagged_at.isoformat() if img.tagged_at else None,
                "tag_provider": img.tag_provider,
                "tags": tags_by_img.get(img.id, []),
            })

        r = await _post(client, "/internal/sync/images", {"images": payload_images})
        total_pushed += r.get("upserted", len(payload_images))
        elapsed = time.perf_counter() - started
        rate = total_pushed / max(elapsed, 0.001)
        eta = (total - total_pushed) / max(rate, 0.001)
        print(f"  images: {total_pushed:>5d} / {total} ({rate:.0f}/s, eta {eta:.0f}s)", flush=True)

    return total_pushed


async def push_synonyms(client: httpx.AsyncClient) -> int:
    from sidecar.routers.match_synonyms import SYNONYMS_FILE
    if not SYNONYMS_FILE.exists():
        return 0
    data = json.loads(SYNONYMS_FILE.read_text(encoding="utf-8"))
    payload = {
        "entries": data.get("entries") or {},
        "version": int(data.get("version") or 0),
    }
    r = await _post(client, "/internal/sync/synonyms", payload)
    return r.get("entries", len(payload["entries"]))


async def push_tag_schema(client: httpx.AsyncClient) -> int:
    from sidecar.routers.tag_schema import _read_schema
    schema = _read_schema()
    r = await _post(client, "/internal/sync/tag-schema", {"schema": schema})
    return r.get("dimensions", len(schema))


# Cloud needs to embed UGC query text into the same vector space the
# library was indexed in. So we push the embedding provider config; we
# also push the general/parser providers so cloud's optional query
# expansion works. We DO NOT push OSS keys or generation providers
# because cloud doesn't upload or generate.
_CLOUD_RELEVANT_KEYS = (
    "default_image_embedding_provider",
    "image_embedding_model_override",
    "default_general_provider",
    "default_parser_provider",
    "general_provider_model",
    "parser_provider_model",
    "custom_relays",
    "match_strategy_weights",
    "match_max_limit",
)


async def push_config(client: httpx.AsyncClient) -> int:
    from sidecar.defaults import CONFIG_FILE
    if not CONFIG_FILE.exists():
        return 0
    full = json.loads(CONFIG_FILE.read_text())
    subset = {k: full[k] for k in _CLOUD_RELEVANT_KEYS if k in full}
    if not subset:
        return 0
    r = await _post(client, "/internal/sync/config", {"settings": subset})
    return len(r.get("updated_keys", subset))


async def main() -> None:
    if not LINTU_CLOUD_SYNC_URL:
        print("ERROR: LINTU_CLOUD_SYNC_URL is not set in environment.", file=sys.stderr)
        print("Example: export LINTU_CLOUD_SYNC_URL=https://api.your-domain.com", file=sys.stderr)
        sys.exit(2)
    if not LINTU_INTERNAL_SYNC_TOKEN:
        print("ERROR: LINTU_INTERNAL_SYNC_TOKEN is not set.", file=sys.stderr)
        sys.exit(2)

    print(f"Bulk-syncing local DB → {LINTU_CLOUD_SYNC_URL}")
    print()

    # Defensive: macOS Clash / system proxies sometimes intercept localhost
    # despite the exception list. Disable proxy when target is loopback so
    # local end-to-end tests don't hit "Server disconnected" via the proxy.
    is_loopback = any(host in LINTU_CLOUD_SYNC_URL for host in ("127.0.0.1", "localhost", "::1"))
    client_kwargs: dict = {
        "timeout": TIMEOUT,
        "headers": {"Authorization": f"Bearer {LINTU_INTERNAL_SYNC_TOKEN}"},
    }
    if is_loopback:
        client_kwargs["proxy"] = None
        client_kwargs["trust_env"] = False
    async with httpx.AsyncClient(**client_kwargs) as client:
        # Health check first — better to fail early with a clear message
        # than to push half the data and then 401.
        try:
            await client.get(f"{LINTU_CLOUD_SYNC_URL.rstrip('/')}/internal/sync/health")
        except httpx.HTTPError as e:
            print(f"ERROR: cloud sidecar unreachable — {e}", file=sys.stderr)
            sys.exit(3)

        steps = [
            ("config",     push_config),       # provider config first — images need it for cloud-side query embedding
            ("projects",   push_projects),
            ("api-keys",   push_api_keys),
            ("synonyms",   push_synonyms),
            ("tag-schema", push_tag_schema),
            ("images",     push_images),
        ]
        for name, fn in steps:
            t0 = time.perf_counter()
            try:
                n = await fn(client)
            except Exception as e:
                print(f"  {name}: FAILED — {e}", file=sys.stderr)
                sys.exit(4)
            dt = time.perf_counter() - t0
            print(f"  {name}: {n} pushed in {dt:.2f}s")

    print()
    print("Done. The cloud sidecar's /open-api/v1/* should now serve real data.")


if __name__ == "__main__":
    asyncio.run(main())
