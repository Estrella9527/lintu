"""In-memory text→image retrieval over Image.embedding.

Strategy:
  - Lazy-build a per-project numpy matrix of L2-normalized embeddings,
    cached in memory; size on disk is ~2KB per image (float16, 1024d), so
    10k images = ~20MB RAM — trivial.
  - Cache invalidated on schema mismatch (model dim changes) or when caller
    asks for a refresh after big imports.
  - Score = cosine similarity = matrix @ query_vec (since vectors are
    pre-normalized).

This is intentionally NOT a persistent vector index (Faiss / Qdrant / pgvector).
At ~10-100k images those still take <100ms with numpy on a single CPU; we
revisit indexing when the corpus crosses 1M images.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
from sqlalchemy import select

from sidecar.db.models import Image
from sidecar.db.session import async_session
from sidecar.defaults import get_setting
from sidecar.engines.clip_embed import deserialize_vector
from sidecar.providers.openai_compat import OpenAICompatProvider

logger = logging.getLogger(__name__)


@dataclass
class IndexShard:
    project_id: Optional[str]
    image_ids: list[str]
    matrix: np.ndarray       # shape (N, D), L2-normalized, float32
    dim: int
    built_at: float
    embedding_model: str     # to detect model mismatch on refresh


class _IndexCache:
    """One in-memory shard per project_id. Builders are serialized so two
    parallel rebuild requests don't both pull 10k rows from SQLite."""

    def __init__(self):
        self._by_project: dict[str | None, IndexShard] = {}
        self._lock = asyncio.Lock()

    async def get_or_build(self, project_id: str | None, *, force: bool = False) -> IndexShard | None:
        async with self._lock:
            existing = self._by_project.get(project_id)
            if existing and not force:
                return existing
            shard = await self._build(project_id)
            if shard:
                self._by_project[project_id] = shard
            return shard

    def invalidate(self, project_id: str | None = None) -> None:
        if project_id is None:
            self._by_project.clear()
        else:
            self._by_project.pop(project_id, None)

    async def _build(self, project_id: str | None) -> IndexShard | None:
        t0 = time.perf_counter()
        async with async_session() as db:
            q = select(Image.id, Image.embedding, Image.embedding_model).where(
                Image.embedding.is_not(None)
            )
            if project_id:
                q = q.where(Image.project_id == project_id)
            rows = (await db.execute(q)).all()

        if not rows:
            logger.info("text_search: no embeddings for project=%s", project_id)
            return None

        # Two-pass build to make the shard's `dim` robust against a single
        # outlier row. Background: a debug-injected or stale row with a
        # mismatched dimension used to land first in SQL row order, which
        # locked shard.dim to the WRONG value and silently dropped every
        # legitimate row. Now we vote: the dim that the majority of rows
        # have wins. Minority dims are skipped with a loud warning so the
        # operator can clean up.
        from collections import Counter
        parsed: list[tuple[str, str | None, np.ndarray]] = []
        for img_id, blob, em in rows:
            v = deserialize_vector(blob)
            if v is None or v.size == 0:
                continue
            parsed.append((img_id, em, v))
        if not parsed:
            return None

        dim_counts = Counter(v.size for _, _, v in parsed)
        majority_dim, majority_n = dim_counts.most_common(1)[0]
        if len(dim_counts) > 1:
            minority = {d: n for d, n in dim_counts.items() if d != majority_dim}
            logger.warning(
                "text_search: project=%s mixed embedding dims %s — using majority %d (%d rows), skipping minority %s",
                project_id, dict(dim_counts), majority_dim, majority_n, minority,
            )

        ids: list[str] = []
        vecs: list[np.ndarray] = []
        model_tag = ""
        skipped_dim_mismatch = 0
        for img_id, em, v in parsed:
            if v.size != majority_dim:
                skipped_dim_mismatch += 1
                continue
            if not model_tag:
                model_tag = em or ""
            n = float(np.linalg.norm(v))
            if n == 0:
                continue
            ids.append(img_id)
            vecs.append((v / n).astype(np.float32))

        if not vecs:
            return None

        matrix = np.vstack(vecs)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info(
            "text_search: built shard project=%s n=%d dim=%d in %dms (skipped_mismatched=%d)",
            project_id, len(ids), majority_dim, elapsed_ms, skipped_dim_mismatch,
        )
        return IndexShard(
            project_id=project_id,
            image_ids=ids,
            matrix=matrix,
            dim=majority_dim,
            built_at=time.time(),
            embedding_model=model_tag,
        )


index_cache = _IndexCache()


# ── Query API ────────────────────────────────────────────────────────────────


@dataclass
class RecallHit:
    image_id: str
    score: float


def _resolve_embedding_relay() -> dict | None:
    """Read default_image_embedding_provider from config; resolve to a relay.

    Returns {"base_url","api_key","model"} or None when not configured. We
    deliberately reuse the IMAGE embedding provider because Ark vision
    embedding lives in the same space as image embeddings — that's what
    makes cross-modal text→image search work without a second model.
    """
    chosen = (get_setting("default_image_embedding_provider") or "").strip()
    if not chosen.startswith("relay:"):
        return None
    name = chosen[len("relay:"):]
    relays_raw = get_setting("custom_relays") or "[]"
    try:
        import json as _json
        relays = _json.loads(relays_raw) if isinstance(relays_raw, str) else relays_raw
    except Exception:
        return None
    relay = next((r for r in relays if r.get("name") == name), None)
    if not relay:
        return None
    override_model = (get_setting("image_embedding_model_override") or "").strip()
    return {
        "base_url": relay["base_url"],
        "api_key": relay["api_key"],
        "model": override_model or relay.get("model") or "doubao-embedding-vision-251215",
    }


# Cached query embeddings: text/model → unit vector. Doubao Ark API call is
# the dominant latency in /images/match (~1.5s). The same UGC text often hits
# us multiple times (different randomness/exclude_ids/limit on refresh, or
# many users seeing the same auto-generated note), so an LRU cache here turns
# the second-and-onwards calls from ~1.9s end-to-end into ~300-500ms.
#
# TTL keeps the cache from holding stale vectors after the operator switches
# embedding providers (vector dim/space would change). 30min is short enough
# that a model swap reflects within an hour without manual invalidation, and
# long enough that high-traffic UGC sees ~100% hit rate on its hot queries.
_query_embed_cache: "OrderedDict[str, tuple[float, np.ndarray]]" = None  # lazy init
_query_embed_cache_lock: asyncio.Lock | None = None
_QUERY_EMBED_CACHE_MAX = 512
_QUERY_EMBED_CACHE_TTL = 1800  # 30 minutes


def _query_cache_key(text: str, model_tag: str) -> str:
    import hashlib
    norm = (text or "").strip().lower()
    return hashlib.sha256(f"{model_tag}|{norm}".encode("utf-8")).hexdigest()[:24]


async def embed_query_text(text: str) -> np.ndarray | None:
    """Run the configured image-embedding provider on text input. Returns a
    L2-normalized float32 vector (same space as image embeddings) or None
    if no embedding provider is configured. Caches successful results by
    (model, normalized text) for ~30 min; cache miss falls through to API.
    """
    global _query_embed_cache, _query_embed_cache_lock
    target = _resolve_embedding_relay()
    if not target:
        return None

    cache_key = _query_cache_key(text, target.get("model") or "")
    if _query_embed_cache is None:
        from collections import OrderedDict
        _query_embed_cache = OrderedDict()
        _query_embed_cache_lock = asyncio.Lock()

    async with _query_embed_cache_lock:
        hit = _query_embed_cache.get(cache_key)
        if hit:
            ts, vec = hit
            if time.time() - ts < _QUERY_EMBED_CACHE_TTL:
                _query_embed_cache.move_to_end(cache_key)
                return vec
            _query_embed_cache.pop(cache_key, None)

    provider = OpenAICompatProvider(
        base_url=target["base_url"],
        api_key=target["api_key"],
        model=target["model"],
    )
    try:
        vec = await provider.embed_text(text)
    except Exception as e:
        logger.warning("text_search: text embedding failed: %s", e)
        return None
    arr = np.asarray(vec, dtype=np.float32)
    n = float(np.linalg.norm(arr))
    if n == 0:
        return None
    unit = arr / n

    async with _query_embed_cache_lock:
        _query_embed_cache[cache_key] = (time.time(), unit)
        _query_embed_cache.move_to_end(cache_key)
        while len(_query_embed_cache) > _QUERY_EMBED_CACHE_MAX:
            _query_embed_cache.popitem(last=False)
    return unit


async def recall_by_text(
    text: str,
    *,
    project_id: str | None = None,
    top_k: int = 200,
) -> list[RecallHit]:
    """Embed the text and return top_k cosine-similar image_ids.

    Empty list when:
      - no embedding provider configured
      - no images have embeddings yet (run dedup or `embed` task first)
      - dim mismatch between text vector and image shard
    """
    qv = await embed_query_text(text)
    if qv is None:
        return []
    return await recall_by_qv(qv, project_id=project_id, top_k=top_k)


async def recall_by_qv(
    qv: np.ndarray,
    *,
    project_id: str | None = None,
    top_k: int = 200,
) -> list[RecallHit]:
    """Same as recall_by_text but skips the embedding round-trip — useful
    when the caller (e.g. multi-project recall in match_strategy) needs to
    score the SAME query against multiple project shards. Always do the
    embedding once externally and reuse the vector here."""
    shard = await index_cache.get_or_build(project_id)
    if not shard:
        return []
    if qv.size != shard.dim:
        logger.warning(
            "text_search: query dim %d != shard dim %d (model mismatch?)",
            qv.size, shard.dim,
        )
        return []
    sims = shard.matrix @ qv  # (N,) cosine similarities
    k = min(int(top_k), sims.shape[0])
    if k <= 0:
        return []
    idx = np.argpartition(-sims, k - 1)[:k]
    idx = idx[np.argsort(-sims[idx])]
    return [RecallHit(image_id=shard.image_ids[i], score=float(sims[i])) for i in idx]


async def recall_by_keywords(
    keywords: list[str],
    *,
    project_id: str | None = None,
    top_k: int = 200,
) -> list[RecallHit]:
    """SQL ILIKE recall over text_search_blob. Score = fraction of keywords hit.

    This complements embedding recall when the user query is dominated by
    proper nouns / project-specific terms (e.g. "悬崖过山车") — the embedding
    model has no idea what that is, but tagger has labelled images with it.
    """
    if not keywords:
        return []
    keywords = [k.strip() for k in keywords if k.strip()]
    if not keywords:
        return []

    async with async_session() as db:
        q = select(Image.id, Image.text_search_blob).where(Image.text_search_blob.is_not(None))
        if project_id:
            q = q.where(Image.project_id == project_id)
        rows = (await db.execute(q)).all()

    hits: list[RecallHit] = []
    for img_id, blob in rows:
        if not blob:
            continue
        bl = blob.lower()
        n = sum(1 for k in keywords if k.lower() in bl)
        if n > 0:
            hits.append(RecallHit(image_id=img_id, score=n / len(keywords)))
    hits.sort(key=lambda h: h.score, reverse=True)
    return hits[:top_k]
