"""Deduplication engine: multi-hash ensemble + Union-Find grouping.

Upgrade summary (v0.2):
  - Three perceptual hashes per image: pHash + dHash + aHash.
    Each is 64 bits (imagehash's default), stored together in Image.phash
    as JSON so existing single-hash rows keep working (we also accept the
    legacy "pure hex" format).
  - Mode presets rather than raw thresholds:
      strict   → Hamming ≤ 4   — 几乎一模一样
      balanced → Hamming ≤ 6   — 90% 相似也会合并（默认）
      aggressive → Hamming ≤ 10 — 角度/裁切变化也合并
    Custom threshold still overrides mode.
  - Ensemble rule: two pairs are duplicates if **≥ 2** of the three hashes
    fall within threshold — trades a single hash's blind spot for the
    aggregate.
  - Union-Find grouping so chained similarities are transitively merged.
  - "Best in group" picks the highest-resolution, sharpest, largest file:
      log(w*h)*0.45 + norm(blur_score)*0.4 + log(size_kb)*0.15
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass

import imagehash
import numpy as np
from PIL import Image as PILImage
from sqlalchemy import delete, select, update

from sidecar.db.models import DuplicateGroup, Image, Task
from sidecar.db.session import async_session
from sidecar.engines.clip_embed import (
    EMBEDDING_TAG_LOCAL,
    BATCH_SIZE as EMBED_BATCH_SIZE,
    _embed_via_api,
    _resolve_api_provider,
    deserialize_vector,
    encode_vector_bytes,
    serialize_vector,
)
from sidecar.engines.image_utils import effective_file_path, register_heif

register_heif()
logger = logging.getLogger(__name__)


MODE_THRESHOLDS = {
    "strict": 4,
    "balanced": 6,
    "aggressive": 10,
}
DEFAULT_MODE = "balanced"

# CLIP cosine-similarity thresholds (higher = stricter / more similar).
# 0.92 — practically identical scene+subject
# 0.88 — same scene, different people / slight angle change
# 0.82 — related topic (same attraction, wider angle range)
SEMANTIC_THRESHOLDS = {
    "strict": 0.92,
    "balanced": 0.88,
    "aggressive": 0.82,
}
DEFAULT_SEMANTIC_MODE = "balanced"

# Chunk size for all-pairs cosine similarity; 500×N matmul ~ 15MB @ N=7.6k
SEMANTIC_CHUNK = 500


# ── Hashing ────────────────────────────────────────────────────────────────


@dataclass
class HashTriple:
    phash: str
    dhash: str
    ahash: str

    def to_json(self) -> str:
        return json.dumps({"p": self.phash, "d": self.dhash, "a": self.ahash})

    @classmethod
    def from_stored(cls, stored: str | None) -> "HashTriple | None":
        """Decode Image.phash. Accepts new JSON form and legacy hex-only form."""
        if not stored:
            return None
        stored = stored.strip()
        if stored.startswith("{"):
            try:
                d = json.loads(stored)
                return cls(phash=d.get("p", ""), dhash=d.get("d", ""), ahash=d.get("a", ""))
            except json.JSONDecodeError:
                return None
        # Legacy: stored was just the pHash hex string
        return cls(phash=stored, dhash="", ahash="")


def _hamming(h1: str, h2: str) -> int:
    if not h1 or not h2 or len(h1) != len(h2):
        return 999
    # imagehash hex strings — XOR the ints to count bit diffs precisely
    try:
        return bin(int(h1, 16) ^ int(h2, 16)).count("1")
    except ValueError:
        return sum(c1 != c2 for c1, c2 in zip(h1, h2))


def _compute_hashes(path: str) -> HashTriple | None:
    try:
        with PILImage.open(path) as raw:
            # Use a downsized copy for stable hashing
            img = raw.convert("RGB")
            img.thumbnail((512, 512))
            return HashTriple(
                phash=str(imagehash.phash(img)),
                dhash=str(imagehash.dhash(img)),
                ahash=str(imagehash.average_hash(img)),
            )
    except Exception as e:
        logger.warning("hash failed for %s: %s", path, e)
        return None


def _pair_is_duplicate(a: HashTriple, b: HashTriple, threshold: int) -> tuple[bool, int]:
    """Return (is_dup, min_hamming). Requires 2/3 hash matches under threshold.

    If a hash is missing on either side, that hash abstains from voting.
    """
    votes_yes = 0
    votes_total = 0
    distances: list[int] = []
    for h_a, h_b in (
        (a.phash, b.phash),
        (a.dhash, b.dhash),
        (a.ahash, b.ahash),
    ):
        if not h_a or not h_b:
            continue
        votes_total += 1
        d = _hamming(h_a, h_b)
        distances.append(d)
        if d <= threshold:
            votes_yes += 1

    # Edge case: legacy rows with only pHash → fall back to single-hash decision
    if votes_total <= 1:
        return (votes_yes >= 1, min(distances) if distances else 999)

    return (votes_yes >= 2, min(distances) if distances else 999)


# ── Union-Find ─────────────────────────────────────────────────────────────


class UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1


# ── Best-in-group scoring ──────────────────────────────────────────────────


def _quality_score(img: Image, max_blur: float) -> float:
    """Higher is better. Balances resolution, sharpness, and file size."""
    wh = max(1, (img.width or 0) * (img.height or 0))
    size_kb = max(1, img.file_size_kb or 1)
    blur = max(0.0, (img.blur_score or 0.0))
    blur_norm = blur / max_blur if max_blur > 0 else 0.0
    return (
        0.45 * math.log(wh + 1)
        + 0.40 * blur_norm * 10
        + 0.15 * math.log(size_kb + 1)
    )


# ── Engine ─────────────────────────────────────────────────────────────────


async def _ensure_embeddings(db, images: list[Image], progress_cb, grand_total: int) -> None:
    """Compute embeddings for any image in `images` that lacks one matching the
    currently-configured backend (local CLIP or API).

    Runs in batches of `EMBED_BATCH_SIZE`. Mutates images in-place so the
    semantic step can read the vectors immediately.
    """
    api_choice = _resolve_api_provider()
    if api_choice is not None:
        provider, embedding_tag = api_choice
    else:
        provider = None
        embedding_tag = EMBEDDING_TAG_LOCAL

    missing_idx = [
        i for i, img in enumerate(images)
        if not img.embedding or img.embedding_model != embedding_tag
    ]
    if not missing_idx:
        return

    n_miss = len(missing_idx)
    logger.info(
        "dedup: computing image embeddings for %d images (backend=%s)",
        n_miss, embedding_tag,
    )
    done = 0
    for chunk_start in range(0, n_miss, EMBED_BATCH_SIZE):
        chunk = missing_idx[chunk_start:chunk_start + EMBED_BATCH_SIZE]
        paths = [effective_file_path(images[i]) for i in chunk]
        if provider is not None:
            vectors = await _embed_via_api(provider, paths)
        else:
            vectors = encode_vector_bytes(paths)
        for local_i, vec in zip(chunk, vectors):
            if vec is None:
                continue
            encoded = serialize_vector(vec)
            await db.execute(
                update(Image).where(Image.id == images[local_i].id)
                .values(embedding=encoded, embedding_model=embedding_tag)
            )
            # Mutate the in-memory image so the semantic step can read it back
            images[local_i].embedding = encoded
            images[local_i].embedding_model = embedding_tag
        done += len(chunk)
        await db.commit()
        await progress_cb(
            processed=grand_total * 2,
            total=grand_total * 2,
            phase="embedding",
            embed_progress=done,
            embed_total=n_miss,
        )


def _semantic_union(images: list[Image], uf: "UnionFind", threshold: float) -> int:
    """Add edges into the Union-Find whenever CLIP cosine similarity ≥ threshold.

    Returns the number of merge operations performed (purely informational —
    UF handles duplicates). Works on a chunked similarity matrix so memory is
    bounded even for tens of thousands of images.
    """
    n = len(images)
    # Materialize embeddings into a dense float32 matrix; images without an
    # embedding don't participate in the semantic phase. We don't assume a
    # fixed dimension — local CLIP is 512, Volcengine Ark is 1024, etc.
    indices_with_emb: list[int] = []
    vectors: list[np.ndarray] = []
    expected_dim: int | None = None
    for i, img in enumerate(images):
        v = deserialize_vector(img.embedding)
        if v is None or v.ndim != 1 or v.size == 0:
            continue
        if expected_dim is None:
            expected_dim = v.size
        elif v.size != expected_dim:
            # Backend was switched mid-batch — skip mismatched vectors
            continue
        indices_with_emb.append(i)
        vectors.append(v)

    if len(vectors) < 2:
        return 0

    matrix = np.stack(vectors).astype(np.float32)   # (M, dim)
    # Already unit-normalized from clip_embed, but renormalize defensively
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    matrix = matrix / np.clip(norms, 1e-6, None)

    merged = 0
    m = len(indices_with_emb)
    for start in range(0, m, SEMANTIC_CHUNK):
        end = min(start + SEMANTIC_CHUNK, m)
        block = matrix[start:end]                     # (chunk, 512)
        sims = block @ matrix.T                        # (chunk, m)
        # Only consider j > global_i to avoid double counting
        for li, gi in enumerate(indices_with_emb[start:end]):
            row = sims[li]
            # Threshold + skip self + skip already-considered (j > gi in global index)
            for lj_global in np.where(row >= threshold)[0]:
                gj = indices_with_emb[lj_global]
                if gj <= gi:
                    continue
                uf.union(gi, gj)
                merged += 1
        del sims
    return merged


async def run_dedup(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    mode = (params.get("mode") or DEFAULT_MODE).lower()
    threshold = int(params.get("threshold") or MODE_THRESHOLDS.get(mode, MODE_THRESHOLDS[DEFAULT_MODE]))

    use_semantic = bool(params.get("use_semantic", False))
    semantic_mode = (params.get("semantic_mode") or DEFAULT_SEMANTIC_MODE).lower()
    semantic_threshold = float(
        params.get("semantic_threshold")
        or SEMANTIC_THRESHOLDS.get(semantic_mode, SEMANTIC_THRESHOLDS[DEFAULT_SEMANTIC_MODE])
    )
    # Re-run scope: when present, only dedup within this subset (and only
    # touch THEIR groups). Quality_status filter is dropped — caller chose
    # these images explicitly. Asset-library bulk-action uses this.
    image_ids: list[str] = params.get("image_ids") or []

    async with async_session() as db:
        if image_ids:
            result = await db.execute(
                select(Image).where(Image.id.in_(image_ids))
            )
        else:
            result = await db.execute(
                select(Image)
                .where(Image.project_id == task.project_id)
                .where(Image.quality_status == "passed")
            )
        images = result.scalars().all()

        # Reset is_kept + drop any prior groups so re-running cleanly regroups.
        # Subset re-runs only clear groups that contained ANY of the selected
        # images, so other groups stay untouched.
        scoped_group_ids: set[str] = set()
        for img in images:
            if img.dedup_group_id:
                scoped_group_ids.add(img.dedup_group_id)
            img.is_kept = True
            img.dedup_group_id = None
        if image_ids:
            if scoped_group_ids:
                # Reset siblings that shared a group with our selection
                await db.execute(
                    update(Image)
                    .where(Image.dedup_group_id.in_(scoped_group_ids))
                    .values(dedup_group_id=None, is_kept=True)
                )
                await db.execute(
                    delete(DuplicateGroup).where(DuplicateGroup.id.in_(scoped_group_ids))
                )
        else:
            await db.execute(
                delete(DuplicateGroup).where(DuplicateGroup.project_id == task.project_id)
            )

        total = len(images)
        if total == 0:
            await progress_cb(total=0, processed=0, phase="done")
            await db.commit()
            return

        logger.info("dedup mode=%s threshold=%d total=%d", mode, threshold, total)

        # ── Phase 1: compute hashes (chunked, short-lived sessions) ──
        # Important: we MUST NOT hold the main db session's write lock while
        # CPU-bound hashing runs for minutes — the scheduler needs to update
        # task progress, and concurrent batch_engine writes need to proceed.
        # Snapshot the data we need, release this session, hash in batches
        # using their own short sessions.
        await db.commit()  # release the cleanup writes from the prior block

        image_data = [(img.id, effective_file_path(img), img.phash) for img in images]
        triples: list[HashTriple | None] = [None] * total
        await progress_cb(total=total * 2, processed=0, phase="hashing")

        HASH_BATCH = 50
        pending: list[tuple[str, str]] = []  # (image_id, phash_json) waiting to write

        async def _flush_pending():
            if not pending:
                return
            async with async_session() as flush_db:
                for img_id, phash_json in pending:
                    await flush_db.execute(
                        update(Image).where(Image.id == img_id).values(phash=phash_json)
                    )
                await flush_db.commit()
            pending.clear()

        for idx, (img_id, file_path, existing_phash) in enumerate(image_data):
            existing = HashTriple.from_stored(existing_phash)
            if existing and existing.phash and existing.dhash and existing.ahash:
                triples[idx] = existing
            else:
                t = _compute_hashes(file_path)
                if t:
                    pending.append((img_id, t.to_json()))
                triples[idx] = t

            if (idx + 1) % HASH_BATCH == 0:
                await _flush_pending()
                await progress_cb(processed=idx + 1, total=total * 2, phase="hashing")
        await _flush_pending()
        await progress_cb(processed=total, total=total * 2, phase="grouping")

        # ── Phase 2: pairwise comparison → Union-Find ──
        uf = UnionFind(total)
        for i in range(total):
            t_i = triples[i]
            if not t_i:
                continue
            for j in range(i + 1, total):
                t_j = triples[j]
                if not t_j:
                    continue
                is_dup, _ = _pair_is_duplicate(t_i, t_j, threshold)
                if is_dup:
                    uf.union(i, j)
            if (i + 1) % 100 == 0:
                await progress_cb(processed=total + i + 1, total=total * 2, phase="grouping")

        # ── Phase 2b (optional): semantic stage via CLIP embeddings ──
        if use_semantic:
            # 2b.1 — make sure every image has an embedding (auto-compute missing)
            await _ensure_embeddings(db, images, progress_cb, total)
            # 2b.2 — cluster by cosine similarity
            await progress_cb(processed=total * 2, total=total * 2, phase="semantic")
            semantic_pairs = _semantic_union(images, uf, semantic_threshold)
            logger.info(
                "semantic dedup: threshold=%.2f, %d semantic pairs merged",
                semantic_threshold, semantic_pairs,
            )

        # Collect groups
        groups_by_root: dict[int, list[int]] = {}
        for idx in range(total):
            root = uf.find(idx)
            groups_by_root.setdefault(root, []).append(idx)
        groups = [g for g in groups_by_root.values() if len(g) > 1]

        # ── Phase 3: persist groups + pick best ──
        max_blur = max((img.blur_score or 0.0) for img in images) or 1.0

        for indices in groups:
            members = [images[i] for i in indices]
            best = max(members, key=lambda m: _quality_score(m, max_blur))

            # Compute average hamming distance across all pairs for reporting
            triples_in_group = [triples[i] for i in indices if triples[i]]
            pair_dists: list[int] = []
            for ai in range(len(triples_in_group)):
                for bj in range(ai + 1, len(triples_in_group)):
                    a, b = triples_in_group[ai], triples_in_group[bj]
                    per = [
                        _hamming(a.phash, b.phash),
                        _hamming(a.dhash, b.dhash),
                        _hamming(a.ahash, b.ahash),
                    ]
                    pair_dists.append(min(d for d in per if d < 999) if any(d < 999 for d in per) else 999)
            avg_dist = (sum(pair_dists) / len(pair_dists)) if pair_dists else 0.0

            dup_group = DuplicateGroup(
                project_id=task.project_id,
                kept_image_id=best.id,
                image_count=len(members),
                avg_hamming_distance=avg_dist,
            )
            db.add(dup_group)
            await db.flush()

            for m in members:
                await db.execute(
                    update(Image)
                    .where(Image.id == m.id)
                    .values(
                        dedup_group_id=dup_group.id,
                        is_kept=(m.id == best.id),
                    )
                )

        await db.commit()
        await progress_cb(
            processed=total * 2, total=total * 2, phase="done",
            groups=len(groups),
            duplicates=sum(len(g) - 1 for g in groups),
        )
        logger.info(
            "dedup done: %d groups, %d duplicates suppressed (mode=%s, threshold=%d)",
            len(groups), sum(len(g) - 1 for g in groups), mode, threshold,
        )
