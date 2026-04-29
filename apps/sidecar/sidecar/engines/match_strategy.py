"""Text→image match strategy: recall fusion + weighted re-rank + diversity.

Pipeline (called from POST /open-api/v1/images/match):

  1. extract = keyword_extract.extract(text)            # tokens + tag hits
  2. emb_hits = text_search.recall_by_text(text)         # top 200 by cosine
  3. kw_hits  = text_search.recall_by_keywords(...)      # top 200 by ILIKE
  4. union ← merge(emb_hits, kw_hits)
  5. enrich union with DB metadata (tags, blur_score, source_type, etc.)
  6. apply user filters (scene/season/exclude/source_type/...)
  7. compute final score per row:
        score = w_emb * embedding_sim
              + w_tag * tag_hit_density
              + w_qual * quality_norm
              + w_div  * diversity_bonus
              + w_biz  * business_rules
  8. sort by score desc, take limit, return with score_breakdown
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from sqlalchemy import select

from sidecar.db.models import Image, Tag
from sidecar.db.session import async_session
from sidecar.defaults import get_setting
from sidecar.engines.keyword_extract import KeywordExtraction, extract as extract_keywords
from sidecar.engines.query_expansion import expand_query
from sidecar.engines.text_search import (
    RecallHit, embed_query_text, index_cache,
    recall_by_keywords, recall_by_qv, recall_by_text,
)

logger = logging.getLogger(__name__)


# ── Strategy presets ────────────────────────────────────────────────────────


@dataclass
class StrategyWeights:
    embedding: float = 0.45
    tag: float = 0.30
    quality: float = 0.10
    diversity: float = 0.10
    business: float = 0.05

    def as_dict(self) -> dict:
        return {
            "embedding": self.embedding, "tag": self.tag,
            "quality": self.quality, "diversity": self.diversity,
            "business": self.business,
        }


STRATEGY_PRESETS: dict[str, StrategyWeights] = {
    "precise":  StrategyWeights(embedding=0.55, tag=0.35, quality=0.05, diversity=0.05, business=0.00),
    # balanced: lowered quality (0.10→0.05) and business (0.05→0.02) so the
    # "always-the-same-sharpest-original" cluster doesn't dominate; diversity
    # bumped (0.10→0.13) to compensate. Net effect: more variety per-call
    # without sacrificing relevance — embedding+tag still drive ranking.
    "balanced": StrategyWeights(embedding=0.45, tag=0.35, quality=0.05, diversity=0.13, business=0.02),
    "diverse":  StrategyWeights(embedding=0.30, tag=0.20, quality=0.10, diversity=0.38, business=0.02),
}


def resolve_weights(strategy: str | None, override: dict | None) -> StrategyWeights:
    if override:
        defaults = STRATEGY_PRESETS["balanced"]
        return StrategyWeights(
            embedding=float(override.get("embedding", defaults.embedding)),
            tag=float(override.get("tag", defaults.tag)),
            quality=float(override.get("quality", defaults.quality)),
            diversity=float(override.get("diversity", defaults.diversity)),
            business=float(override.get("business", defaults.business)),
        )
    # Try config-level default first
    cfg = get_setting("match_strategy_weights")
    if isinstance(cfg, dict):
        return StrategyWeights(
            embedding=float(cfg.get("embedding", 0.45)),
            tag=float(cfg.get("tag", 0.30)),
            quality=float(cfg.get("quality", 0.10)),
            diversity=float(cfg.get("diversity", 0.10)),
            business=float(cfg.get("business", 0.05)),
        )
    return STRATEGY_PRESETS.get((strategy or "balanced").lower(), STRATEGY_PRESETS["balanced"])


# ── Filter spec ──────────────────────────────────────────────────────────────


@dataclass
class MatchFilters:
    scene: list[str] = field(default_factory=list)
    facility: list[str] = field(default_factory=list)
    season: list[str] = field(default_factory=list)
    weather: list[str] = field(default_factory=list)
    angle: list[str] = field(default_factory=list)
    people: list[str] = field(default_factory=list)
    usage: list[str] = field(default_factory=list)
    exclude_tags: dict[str, list[str]] = field(default_factory=dict)
    source_type: Optional[str] = None        # 'original' | 'generated' | None
    project_id: Optional[str] = None         # legacy hard scope; prefer MatchScope
    folder_prefix: Optional[str] = None


# ── Multi-project scope (auto-decided, not a user knob) ─────────────────────


@dataclass
class MatchScope:
    """How the matcher should distribute candidates across projects.

    `primary_project_id` is the call's "home" project — typically the project
    bound to the API key, or in the playground, the operator's currently
    selected project. The matcher recalls per-project shards independently
    (no cross-shard pollution) but the final result is taken entirely from
    the primary project; other projects do not contribute slots.

    `force_single_project` is retained as an explicit short-circuit; with the
    primary-only quota policy it produces the same outcome as default.
    """
    primary_project_id: Optional[str] = None
    force_single_project: bool = False


@dataclass
class ScopeDecision:
    """Auditable record of how the auto-scope algorithm split the limit.
    Returned in the API response so callers can show "为你推荐" / "相关项目"
    badges based on which slot a result came from."""
    primary_project_id: Optional[str]
    raw_signals: dict[str, float] = field(default_factory=dict)        # mean top-5 cosine per project
    weighted_signals: dict[str, float] = field(default_factory=dict)   # after noise + boost + thresholds
    weights: dict[str, float] = field(default_factory=dict)            # softmax + primary floor
    quotas: dict[str, int] = field(default_factory=dict)               # final integer quotas

    def as_dict(self) -> dict:
        return {
            "primary_project_id": self.primary_project_id,
            "raw_signals": {k: round(v, 4) for k, v in self.raw_signals.items()},
            "weighted_signals": {k: round(v, 4) for k, v in self.weighted_signals.items()},
            "weights": {k: round(v, 4) for k, v in self.weights.items()},
            "selected_quota": self.quotas,
        }


# Tunables for the auto-scope algorithm. Picked conservatively: most queries
# concentrate on a single project unless the text really has substantive
# content for another one.
_NOISE_FLOOR = 0.30           # cross-modal cosine baseline; below this is noise
_PRIMARY_BOOST = 1.3          # primary project's signal gets bumped before thresholding
_ABS_THRESHOLD = 0.10         # cross-project signal must be at least this above noise
_REL_THRESHOLD = 0.40         # cross-project signal must reach this fraction of primary's
_TEMPERATURE = 0.3            # softmax temperature; low = sharp distribution
_PRIMARY_FLOOR_RATIO = 1.0    # primary takes the full limit; no cross-project leakage
_SIGNAL_TOP_K = 5             # mean of top-K cosines defines the per-project signal


async def _list_projects_with_embeddings() -> list[str]:
    """Projects that have at least one embedded image. Anything else can't
    contribute to embedding-based recall anyway, so we skip them in the
    quota loop to avoid a wasted shard build."""
    async with async_session() as db:
        rows = await db.execute(
            select(Image.project_id).distinct()
            .where(Image.embedding.is_not(None))
            .where(Image.embedding != "")
        )
    return [row[0] for row in rows.all() if row[0]]


async def _compute_scope_quotas(
    qv: np.ndarray,
    *,
    primary_project_id: Optional[str],
    limit: int,
    force_single_project: bool = False,
) -> ScopeDecision:
    """Plan how many candidates each project should contribute, based on the
    query's actual relevance to that project's image set (mean top-K cosine).

    Conservative by design: 'mentioning another project in passing' should
    NOT trigger cross-project leakage. Only substantial relevance crosses
    the absolute and relative thresholds. See the comments around the
    constants above for tuning context."""
    decision = ScopeDecision(primary_project_id=primary_project_id)

    if force_single_project and primary_project_id:
        decision.weights = {primary_project_id: 1.0}
        decision.quotas = {primary_project_id: limit}
        return decision

    pids = await _list_projects_with_embeddings()
    if not pids:
        return decision

    # 1. Per-project raw signal: mean of top-K cosines.
    for pid in pids:
        shard = await index_cache.get_or_build(pid)
        if not shard or qv.size != shard.dim:
            continue
        sims = shard.matrix @ qv
        k = min(_SIGNAL_TOP_K, sims.shape[0])
        if k == 0:
            continue
        # partial sort: get top-k unsorted, then mean
        topk_idx = np.argpartition(-sims, k - 1)[:k]
        decision.raw_signals[pid] = float(sims[topk_idx].mean())

    # 2. Subtract noise floor + apply primary boost.
    weighted: dict[str, float] = {}
    for pid, r in decision.raw_signals.items():
        s = max(0.0, r - _NOISE_FLOOR)
        if pid == primary_project_id:
            s *= _PRIMARY_BOOST
        weighted[pid] = s

    # 3. Apply thresholds — only to non-primary projects. Primary is allowed
    #    in regardless because the user IS on this project's UGC page; even
    #    a weak relevance is better than empty results.
    primary_signal = weighted.get(primary_project_id or "", 0.0)
    for pid in list(weighted.keys()):
        if pid == primary_project_id:
            continue
        s = weighted[pid]
        if s < _ABS_THRESHOLD:
            weighted[pid] = 0.0
            continue
        if primary_signal > 0 and s < _REL_THRESHOLD * primary_signal:
            weighted[pid] = 0.0
    decision.weighted_signals = weighted

    # 4. Softmax with low temperature → sharp concentration on top.
    active = [(pid, s) for pid, s in weighted.items() if s > 0]
    if not active:
        # No project crossed the threshold. If we have a primary at all (even
        # below threshold), it gets everything; otherwise empty.
        if primary_project_id and primary_project_id in decision.raw_signals:
            decision.weights = {primary_project_id: 1.0}
            decision.quotas = {primary_project_id: limit}
        return decision

    pids_a = [p for p, _ in active]
    sigs = np.asarray([s for _, s in active], dtype=np.float64)
    logits = sigs / _TEMPERATURE
    logits -= logits.max()
    exps = np.exp(logits)
    raw_w = exps / exps.sum()
    weights_map = {pid: float(w) for pid, w in zip(pids_a, raw_w)}

    # 5. Primary floor: pull primary up to ≥ floor ratio if needed.
    if primary_project_id in weights_map and weights_map[primary_project_id] < _PRIMARY_FLOOR_RATIO:
        others = [p for p in weights_map if p != primary_project_id]
        other_total = sum(weights_map[p] for p in others)
        if other_total > 0:
            target_other = 1.0 - _PRIMARY_FLOOR_RATIO
            scale = target_other / other_total
            for p in others:
                weights_map[p] *= scale
        weights_map[primary_project_id] = _PRIMARY_FLOOR_RATIO
    decision.weights = weights_map

    # 6. Convert to integer quotas summing to limit.
    quotas = {pid: int(round(w * limit)) for pid, w in weights_map.items()}
    delta = limit - sum(quotas.values())
    if delta != 0 and quotas:
        biggest = max(quotas, key=lambda p: weights_map[p])
        quotas[biggest] += delta
    decision.quotas = {pid: q for pid, q in quotas.items() if q > 0}
    return decision


# ── Match request + result ──────────────────────────────────────────────────


@dataclass
class MatchedImage:
    id: str
    score: float
    score_breakdown: dict[str, float]
    embedding_sim: float
    matched_tags: list[dict]
    file_name: str
    width: int | None
    height: int | None
    blur_score: float | None
    source_type: str
    description: str | None
    relative_dir: str
    tags_by_dim: dict[str, list[str]]
    cdn_path: str | None
    project_id: Optional[str] = None
    is_primary_project: bool = False


# ── Core match function ─────────────────────────────────────────────────────


async def match_text_to_images(
    text: str,
    *,
    limit: int = 8,
    filters: MatchFilters | None = None,
    scope: MatchScope | None = None,
    strategy: str = "balanced",
    weights_override: dict | None = None,
    diversity_mode: str = "balanced",     # strict | balanced | none
    randomness: float = 0.0,              # 0.0 = deterministic, 0.3-0.6 = mild variety, 1.0 = heavy shuffle within score band
    exclude_ids: list[str] | None = None, # image_ids to skip (UGC passes "already shown" set for fresh-on-refresh)
    unique_per_source: bool = True,       # True = at most 1 image per parent_id family (incl. originals + variants)
) -> tuple[list[MatchedImage], dict]:
    """Run the full text→image match pipeline.

    Returns (matches, debug_meta). debug_meta is for logging / observability;
    callers can ignore it. matches is at most `limit` items, sorted by final
    score descending.

    Scope handling:
      - If `scope.primary_project_id` is set, recall is split per project
        based on each project's actual relevance to the text (auto-quota).
      - Otherwise we fall back to a single-shard recall using
        `filters.project_id` (legacy / admin path).
    """
    filters = filters or MatchFilters()
    scope = scope or MatchScope()
    weights = resolve_weights(strategy, weights_override)

    import asyncio

    # 1. keyword extraction (cheap, sync — for tag-hit identification)
    kw = extract_keywords(text)

    # 2. Fan out the slow network calls in parallel.
    #    expand_query and embed_query_text both make external API calls; their
    #    latencies dominate the request. We additionally kick keyword recall
    #    against the jieba tokens in parallel — the LLM-expanded set will be
    #    re-checked after expand_query resolves, but the jieba-only recall
    #    almost always overlaps the final superset, so it's not wasted work
    #    when the user's text is short.
    #
    #    expand_query has its own internal timeout (now 1.5s by default);
    #    when it times out we still proceed with jieba-only keywords, so the
    #    pipeline never blocks longer than the embed call (typically <2s).
    expand_task = asyncio.create_task(expand_query(text))
    embed_task = asyncio.create_task(embed_query_text(text))
    expanded_keywords, qv = await asyncio.gather(expand_task, embed_task)

    # 3. embedding recall — fan out per project shard concurrently. Sequential
    #    awaits cost ~50ms per project on a warm shard; this gets us back into
    #    a single-shard's worth of latency regardless of project count.
    decision: ScopeDecision | None = None
    emb_hits: list[RecallHit] = []
    kw_recall_task: asyncio.Task | None = None
    if qv is not None:
        if scope.primary_project_id or scope.force_single_project:
            decision = await _compute_scope_quotas(
                qv,
                primary_project_id=scope.primary_project_id,
                limit=limit,
                force_single_project=scope.force_single_project,
            )
            # Over-fetch per project so re-ranking has headroom for diversity
            # / filter loss / exclude_ids. Floor doubled to 400 (was 200) so
            # the long-tail of mid-quality candidates has a real chance of
            # surfacing once randomness / exclude_ids push the obvious top
            # picks out of the way.
            recall_tasks = [
                recall_by_qv(qv, project_id=pid, top_k=max(400, q * 16))
                for pid, q in decision.quotas.items()
            ]
            # Kick keyword recall in parallel with embedding recalls — both
            # hit different code paths (in-memory matrix vs SQL) and the
            # candidate pools are unioned after.
            keyword_set = list(dict.fromkeys((expanded_keywords or []) + kw.keywords))
            kw_scope_pid = filters.project_id if not scope.primary_project_id else None
            kw_recall_task = asyncio.create_task(
                recall_by_keywords(keyword_set, project_id=kw_scope_pid, top_k=400)
            )
            for hits in await asyncio.gather(*recall_tasks):
                emb_hits.extend(hits)
        else:
            keyword_set = list(dict.fromkeys((expanded_keywords or []) + kw.keywords))
            kw_recall_task = asyncio.create_task(
                recall_by_keywords(keyword_set, project_id=filters.project_id, top_k=400)
            )
            emb_hits = await recall_by_qv(qv, project_id=filters.project_id, top_k=400)
    else:
        keyword_set = list(dict.fromkeys((expanded_keywords or []) + kw.keywords))
        kw_scope_pid = filters.project_id if not scope.primary_project_id else None
        kw_recall_task = asyncio.create_task(
            recall_by_keywords(keyword_set, project_id=kw_scope_pid, top_k=400)
        )

    kw_hits = await kw_recall_task if kw_recall_task else []

    # 3. RRF (Reciprocal Rank Fusion) — combines two ranked lists by summing
    #    1/(k + rank). More robust than additive scores because it doesn't
    #    require the two recall sources to be on the same scale.
    candidates = _rrf_merge(emb_hits, kw_hits, k=60)
    if not candidates:
        empty = {
            "kw_tokens": kw.keywords[:20],
            "expanded_keywords": expanded_keywords[:25],
            "tag_hits": {k: list(v) for k, v in kw.tag_hits.items()},
            "recall_emb": 0,
            "recall_kw": 0,
            "candidates": 0,
        }
        if decision is not None:
            empty["scope_decision"] = decision.as_dict()
        return [], empty

    # 5. fetch metadata + 6. apply filters in one DB pass
    enriched = await _enrich_and_filter(list(candidates.keys()), candidates, filters)

    # 6b. apply caller-supplied exclude_ids ("user has already seen these,
    # don't show again"). UGC stores recently-shown image_ids in localStorage
    # and passes them on each refresh — turns the API into a "stream of fresh
    # results" instead of a deterministic top-N.
    if exclude_ids:
        excluded_set = set(exclude_ids)
        enriched = [row for row in enriched if row["id"] not in excluded_set]

    if not enriched:
        empty = {
            "kw_tokens": kw.keywords[:20],
            "tag_hits": {k: list(v) for k, v in kw.tag_hits.items()},
            "recall_emb": len(emb_hits),
            "recall_kw": len(kw_hits),
            "candidates": len(candidates),
            "after_filters": 0,
        }
        if decision is not None:
            empty["scope_decision"] = decision.as_dict()
        return [], empty

    # 7. score each
    quality_max = max((row.get("blur_score") or 0.0) for row in enriched) or 1.0
    expected_tags = sum(len(v) for v in kw.tag_hits.values()) or 1
    for row in enriched:
        row.update(_score_one(row, kw, weights, quality_max=quality_max, expected_tags=expected_tags))

    # 7b. optional score jitter for variety. With randomness=0 (default) the
    # output is fully deterministic. With randomness>0 we add a uniform [0, R*max_score)
    # perturbation per row, which lets mid-pack candidates occasionally bubble
    # into the top-N on different calls — useful when UGC text is repetitive
    # and the same query keeps surfacing the same images. The jitter is
    # bounded so very-high-score rows still dominate; only ties / near-ties
    # get reshuffled.
    if randomness and randomness > 0 and enriched:
        import random
        max_score = max(r["score"] for r in enriched) or 1.0
        amplitude = float(randomness) * max_score * 0.5
        for r in enriched:
            r["score"] = float(r["score"]) + random.uniform(0, amplitude)

    enriched.sort(key=lambda r: r["score"], reverse=True)

    # 8. apply per-project quota when scope is active. Each project gets at
    # most `decision.quotas[pid]` slots; diversity is applied within each
    # bucket so we don't penalize the same parent across project lines.
    if decision and decision.quotas:
        by_project: dict[str, list[dict]] = {}
        for row in enriched:
            pid = row.get("project_id")
            if pid in decision.quotas:
                by_project.setdefault(pid, []).append(row)
        per_project_final: list[dict] = []
        for pid, q in decision.quotas.items():
            bucket = by_project.get(pid, [])
            picked = _apply_diversity(bucket, limit=q, mode=diversity_mode, weights=weights, unique_per_source=unique_per_source)
            per_project_final.extend(picked)
        # Re-sort globally so the response is monotone-decreasing in score.
        per_project_final.sort(key=lambda r: r["score"], reverse=True)
        final = per_project_final[:limit]
    else:
        final = _apply_diversity(enriched, limit=limit, mode=diversity_mode, weights=weights, unique_per_source=unique_per_source)

    debug = {
        "kw_tokens": kw.keywords[:20],
        "expanded_keywords": expanded_keywords[:25],
        "tag_hits": {k: list(v) for k, v in kw.tag_hits.items()},
        "recall_emb": len(emb_hits),
        "recall_kw": len(kw_hits),
        "candidates": len(candidates),
        "after_filters": len(enriched),
        "weights": weights.as_dict(),
        "strategy": strategy,
    }
    if decision is not None:
        debug["scope_decision"] = decision.as_dict()
    return [_build_matched_image(r, scope.primary_project_id) for r in final], debug


# ── RRF (Reciprocal Rank Fusion) ─────────────────────────────────────────────


def _rrf_merge(
    emb_hits: list[RecallHit],
    kw_hits: list[RecallHit],
    *,
    k: int = 60,
) -> dict[str, dict]:
    """Combine two ranked lists into a unified candidate dict.

    Each candidate gets:
      - embedding_sim: raw cosine score from emb_hits (0.0 if not in emb_hits)
      - kw_score:      raw keyword density from kw_hits (0.0 if missed)
      - rrf_score:     1/(k+r_emb) + 1/(k+r_kw), used downstream as a robust
                       blended ranking signal independent of score scale

    k=60 is the canonical RRF constant (Cormack et al. 2009); larger k
    gives later ranks more weight, smaller k makes the top-1 dominate.
    """
    candidates: dict[str, dict] = {}
    for rank, h in enumerate(emb_hits, start=1):
        candidates[h.image_id] = {
            "id": h.image_id,
            "embedding_sim": h.score,
            "kw_score": 0.0,
            "rrf_score": 1.0 / (k + rank),
        }
    for rank, h in enumerate(kw_hits, start=1):
        if h.image_id in candidates:
            candidates[h.image_id]["kw_score"] = h.score
            candidates[h.image_id]["rrf_score"] += 1.0 / (k + rank)
        else:
            candidates[h.image_id] = {
                "id": h.image_id,
                "embedding_sim": 0.0,
                "kw_score": h.score,
                "rrf_score": 1.0 / (k + rank),
            }
    return candidates


# ── Enrichment + filtering ──────────────────────────────────────────────────


async def _enrich_and_filter(
    image_ids: list[str],
    candidates: dict[str, dict],
    filters: MatchFilters,
) -> list[dict]:
    if not image_ids:
        return []
    async with async_session() as db:
        img_rows = await db.execute(
            select(
                Image.id, Image.file_name, Image.width, Image.height,
                Image.blur_score, Image.source_type, Image.description,
                Image.relative_dir, Image.parent_id, Image.cdn_path,
                Image.project_id,
            ).where(Image.id.in_(image_ids))
        )
        meta = {r[0]: r for r in img_rows.all()}

        tag_rows = await db.execute(
            select(Tag.image_id, Tag.dimension, Tag.value).where(Tag.image_id.in_(image_ids))
        )
        tags_by_img: dict[str, dict[str, list[str]]] = {}
        for img_id, dim, val in tag_rows.all():
            tags_by_img.setdefault(img_id, {}).setdefault(dim, []).append(val)

    out: list[dict] = []
    for img_id in image_ids:
        if img_id not in meta:
            continue
        m = meta[img_id]
        cand = candidates[img_id]
        img_tags = tags_by_img.get(img_id, {})

        # filter: source_type
        if filters.source_type and m[5] != filters.source_type:
            continue
        # filter: relative_dir prefix
        if filters.folder_prefix:
            rd = m[7] or ""
            if not (rd == filters.folder_prefix or rd.startswith(filters.folder_prefix + "/")):
                continue

        # filter: positive dimension constraints
        positive_filters = {
            "scene": filters.scene, "facility": filters.facility,
            "season": filters.season, "weather": filters.weather,
            "angle": filters.angle, "people": filters.people,
            "usage": filters.usage,
        }
        ok = True
        for dim, allowed in positive_filters.items():
            if not allowed:
                continue
            vs = img_tags.get(dim, [])
            if not any(v in allowed for v in vs):
                ok = False
                break
        if not ok:
            continue

        # filter: exclude_tags
        for dim, blocked in filters.exclude_tags.items():
            if not blocked:
                continue
            vs = img_tags.get(dim, [])
            if any(v in blocked for v in vs):
                ok = False
                break
        if not ok:
            continue

        out.append({
            "id": img_id,
            "file_name": m[1],
            "width": m[2], "height": m[3],
            "blur_score": m[4],
            "source_type": m[5],
            "description": m[6],
            "relative_dir": m[7] or "",
            "parent_id": m[8],
            "cdn_path": m[9],
            "project_id": m[10],
            "embedding_sim": cand["embedding_sim"],
            "kw_score": cand["kw_score"],
            "rrf_score": cand.get("rrf_score", 0.0),
            "tags_by_dim": img_tags,
        })
    return out


# ── Per-image scoring ────────────────────────────────────────────────────────


def _score_one(
    row: dict,
    kw: KeywordExtraction,
    weights: StrategyWeights,
    *,
    quality_max: float,
    expected_tags: int,
) -> dict:
    emb = float(row.get("embedding_sim") or 0.0)
    # Tag hit density: how many of the query's identified tag values are
    # present on this image (per dimension), averaged over the dimensions
    # the user mentioned.
    tags_by_dim = row.get("tags_by_dim") or {}
    matched_tag_pairs: list[dict] = []
    if kw.tag_hits:
        hit_count = 0
        for dim, expected_values in kw.tag_hits.items():
            for v in expected_values:
                if v in tags_by_dim.get(dim, []):
                    hit_count += 1
                    matched_tag_pairs.append({"dimension": dim, "value": v})
        tag_score = hit_count / expected_tags
    else:
        # No tag hints in query → fall back to keyword density score
        tag_score = float(row.get("kw_score") or 0.0)

    # Quality: blur_score (higher = sharper). Normalise within candidate set.
    blur = float(row.get("blur_score") or 0.0)
    quality_score = blur / quality_max if quality_max > 0 else 0.0

    # Business rules: prefer original photos slightly over generated.
    biz_score = 1.0 if row.get("source_type") == "original" else 0.5

    # Diversity: applied later in _apply_diversity (this is a placeholder).
    div_score = 0.0

    # When the embedding library is empty / dim-mismatched, emb=0.0 and the
    # caller is essentially relying on tag+kw signals. Fold rrf_score in as a
    # tiny boost so RRF-fused candidates still get a leg up over those that
    # only matched on a single source. Capped to keep tag/embedding dominant.
    rrf = float(row.get("rrf_score") or 0.0)
    rrf_boost = min(rrf * 5.0, 0.10)   # rrf_score is tiny (1/60 ≈ 0.017); scale up

    final = (
        weights.embedding * emb
        + weights.tag * tag_score
        + weights.quality * quality_score
        + weights.diversity * div_score
        + weights.business * biz_score
        + rrf_boost
    )

    return {
        "score": float(final),
        "score_breakdown": {
            "embedding": float(emb),
            "tag": float(tag_score),
            "quality": float(quality_score),
            "business": float(biz_score),
            "rrf_boost": float(rrf_boost),
        },
        "matched_tag_pairs": matched_tag_pairs,
    }


# ── Diversity post-pass ─────────────────────────────────────────────────────


def _apply_diversity(
    sorted_rows: list[dict],
    *,
    limit: int,
    mode: str,
    weights: StrategyWeights,
    unique_per_source: bool = True,
) -> list[dict]:
    """Penalise consecutive picks from the same seed / dir / scene-tag combo.

    mode='none'    → return top N by raw score (no diversity)
    mode='balanced'→ caps: parent_id ≤1 (when unique_per_source) else ≤2,
                     relative_dir ≤2, scene+facility tag combo ≤2
    mode='strict'  → caps: every group key ≤1

    `unique_per_source=True` (default) tightens the parent_id cap to 1 even
    in balanced mode, so a single original + all its AI variants count as
    one "image family" — only the highest-scoring representative is shown.
    Pass False to allow up to 2 variants of the same source (legacy behavior
    pre-optimization).

    The scene+facility tag combo grouping makes balanced/strict feel diverse
    even when candidates have unique parents: many photos may share a
    "山地景观 + 玻璃滑道" depiction. Capping by tag combo forces a mix.
    """
    if mode == "none" or weights.diversity == 0:
        return sorted_rows[:limit]

    base_cap = 1 if mode == "strict" else 2
    parent_cap = 1 if (mode == "strict" or unique_per_source) else base_cap
    dir_cap = base_cap
    tag_cap = base_cap

    seen_parent: dict[str, int] = {}
    seen_dir: dict[str, int] = {}
    seen_tag_combo: dict[tuple, int] = {}
    picked: list[dict] = []
    runners_up: list[dict] = []

    for row in sorted_rows:
        p = row.get("parent_id") or row["id"]
        d = row.get("relative_dir") or ""
        tags_by_dim = row.get("tags_by_dim") or {}
        tag_combo = (
            tuple(sorted(set(tags_by_dim.get("scene", []))))[:2],
            tuple(sorted(set(tags_by_dim.get("facility", []))))[:2],
        )
        if (
            seen_parent.get(p, 0) >= parent_cap
            or seen_dir.get(d, 0) >= dir_cap
            or seen_tag_combo.get(tag_combo, 0) >= tag_cap
        ):
            runners_up.append(row)
            continue
        seen_parent[p] = seen_parent.get(p, 0) + 1
        seen_dir[d] = seen_dir.get(d, 0) + 1
        seen_tag_combo[tag_combo] = seen_tag_combo.get(tag_combo, 0) + 1
        picked.append(row)
        if len(picked) >= limit:
            break

    # Pad with runners_up if filters left us short
    if len(picked) < limit:
        picked.extend(runners_up[: (limit - len(picked))])
    return picked[:limit]


# ── Build public DTO ─────────────────────────────────────────────────────────


def _build_matched_image(row: dict, primary_project_id: Optional[str] = None) -> MatchedImage:
    pid = row.get("project_id")
    return MatchedImage(
        id=row["id"],
        score=row["score"],
        score_breakdown=row["score_breakdown"],
        embedding_sim=float(row.get("embedding_sim") or 0.0),
        matched_tags=row.get("matched_tag_pairs", []),
        file_name=row["file_name"],
        width=row.get("width"),
        height=row.get("height"),
        blur_score=row.get("blur_score"),
        source_type=row["source_type"],
        description=row.get("description"),
        relative_dir=row.get("relative_dir", ""),
        tags_by_dim=row.get("tags_by_dim") or {},
        cdn_path=row.get("cdn_path"),
        project_id=pid,
        is_primary_project=(pid is not None and pid == primary_project_id),
    )
