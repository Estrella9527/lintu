"""Open API v1 — public endpoints for external systems (H5, dashboards, etc.).

Mounted at `/open-api/v1/*`. In `LINTU_MODE=server` every request (except
`/open-api/v1/health`) goes through `middleware.auth.AuthMiddleware`, then
rate limit, then audit logging.

Response envelope: each endpoint returns the actual payload directly to keep
deserializers simple. Errors come back as `{ "error": "<code>", "detail": "..." }`
with the appropriate HTTP status.

Rough scopes (enforced once we wire scope checks into the middleware):
  - images:read, tags:read, matrix:read, batches:read, generate:write
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.config import THUMBNAILS_DIR
from sidecar.db.models import BatchRun, BatchSubtask, Image, MatchFeedback, Tag
from sidecar.defaults import get_setting
from sidecar.db.session import get_db
from sidecar.engines.match_strategy import MatchFilters, MatchScope, match_text_to_images, STRATEGY_PRESETS
from sidecar.engines.oss_sync import get_storage, object_key_for
from sidecar.engines.thumbnail import THUMBNAIL_SIZES, generate_thumbnail, get_thumbnail_path
from sidecar.middleware.scope import require_scope
from sidecar.scheduler.batch_engine import batch_scheduler

router = APIRouter()


@router.get("/health")
async def health():
    return {"status": "ok", "version": "v1"}


# ── Images ──────────────────────────────────────────────────────────────────


def _image_payload(img: Image) -> dict:
    """Build the public payload. URLs prefer CDN when the image has been
    synced (Image.cdn_path is set); otherwise we fall back to streaming
    via the local /file endpoint (slower but always works)."""
    from sidecar.engines.oss_sync import get_storage, object_key_for

    storage = get_storage()
    cdn_path = getattr(img, "cdn_path", None)
    if cdn_path and storage.is_configured():
        # Original URL straight from CDN
        original_url = storage.public_url(cdn_path)
        # Thumb URLs follow the {id}_{size}.jpg convention from oss_sync
        thumb_300_key = object_key_for(img.id, "thumb_300", "jpg")
        thumbnail_url = storage.public_url(thumb_300_key)
    else:
        original_url = f"/open-api/v1/images/{img.id}/file"
        thumbnail_url = f"/open-api/v1/images/{img.id}/file?size=300"

    return {
        "id": img.id,
        "file_name": img.file_name,
        "width": img.width,
        "height": img.height,
        "source_type": img.source_type,
        "description": img.description,
        "relative_dir": img.relative_dir or "",
        "thumbnail_url": thumbnail_url,
        "original_url": original_url,
        "cdn_synced": bool(cdn_path),
    }


@router.get("/images", dependencies=[Depends(require_scope("images:read"))])
async def list_images(
    project_id: Optional[str] = None,
    source_type: Optional[str] = None,
    scene: Optional[List[str]] = Query(None),
    season: Optional[List[str]] = Query(None),
    folder: Optional[str] = None,
    folder_prefix: Optional[str] = None,
    offset: int = 0,
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
):
    query = select(Image).where(Image.quality_status == "passed", Image.is_kept == True)  # noqa: E712
    if project_id:
        query = query.where(Image.project_id == project_id)
    if source_type:
        query = query.where(Image.source_type == source_type)
    if folder is not None:
        query = query.where(Image.relative_dir == folder)
    elif folder_prefix:
        query = query.where(
            (Image.relative_dir == folder_prefix) |
            Image.relative_dir.like(f"{folder_prefix}/%")
        )
    for dim, values in [("scene", scene), ("season", season)]:
        if values:
            subq = select(Tag.image_id).where(Tag.dimension == dim, Tag.value.in_(values))
            query = query.where(Image.id.in_(subq))

    total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = await db.execute(query.order_by(Image.created_at.desc()).offset(offset).limit(limit))
    items = rows.scalars().all()
    return {"total": total, "offset": offset, "limit": limit, "items": [_image_payload(i) for i in items]}


@router.get("/images/{image_id}", dependencies=[Depends(require_scope("images:read"))])
async def get_image(image_id: str, db: AsyncSession = Depends(get_db)):
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    tag_rows = await db.execute(select(Tag).where(Tag.image_id == image_id))
    tags: dict[str, list[str]] = {}
    for t in tag_rows.scalars().all():
        tags.setdefault(t.dimension, []).append(t.value)
    return {**_image_payload(img), "tags": tags}


@router.get("/images/{image_id}/derivatives", dependencies=[Depends(require_scope("images:read"))])
async def list_derivatives(image_id: str, db: AsyncSession = Depends(get_db)):
    """All images that were generated from this seed (parent_id chain)."""
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    rows = await db.execute(select(Image).where(Image.parent_id == image_id).order_by(Image.created_at.desc()))
    children = rows.scalars().all()
    return {
        "parent_id": image_id,
        "count": len(children),
        "items": [_image_payload(c) for c in children],
    }


@router.get("/images/{image_id}/file", dependencies=[Depends(require_scope("images:download"))])
async def get_image_file(
    image_id: str,
    size: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
):
    img = await db.get(Image, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    if size and size in THUMBNAIL_SIZES:
        thumb_path = get_thumbnail_path(image_id, size, THUMBNAILS_DIR)
        source = Path(img.file_path)
        needs_regen = not thumb_path.exists()
        if not needs_regen:
            try:
                if source.exists() and source.stat().st_mtime > thumb_path.stat().st_mtime:
                    needs_regen = True
            except OSError:
                needs_regen = True
        if needs_regen:
            if not source.exists():
                raise HTTPException(404, "Source file not found")
            generate_thumbnail(str(source), thumb_path, size)
        return FileResponse(
            thumb_path,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    source = Path(img.file_path)
    if not source.exists():
        raise HTTPException(404, "Source file not found")
    return FileResponse(
        source,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ── Tags ────────────────────────────────────────────────────────────────────


@router.get("/tags", dependencies=[Depends(require_scope("tags:read"))])
async def list_tags(
    project_id: Optional[str] = None,
    dimension: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(Tag.dimension, Tag.value, func.count(Tag.id).label("count"))
        .group_by(Tag.dimension, Tag.value)
        .order_by(Tag.dimension, func.count(Tag.id).desc())
    )
    if project_id:
        query = query.join(Image, Tag.image_id == Image.id).where(Image.project_id == project_id)
    if dimension:
        query = query.where(Tag.dimension == dimension)
    rows = await db.execute(query)
    return [{"dimension": r[0], "value": r[1], "count": r[2]} for r in rows]


# ── Stats ───────────────────────────────────────────────────────────────────


@router.get("/stats", dependencies=[Depends(require_scope("stats:read"))])
async def stats(project_id: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    q = select(Image)
    if project_id:
        q = q.where(Image.project_id == project_id)
    total = await db.scalar(select(func.count()).select_from(q.subquery())) or 0
    passed = await db.scalar(select(func.count()).select_from(q.where(Image.quality_status == "passed").subquery())) or 0
    generated = await db.scalar(select(func.count()).select_from(q.where(Image.source_type == "generated").subquery())) or 0
    tagged = await db.scalar(select(func.count()).select_from(q.where(Image.tag_status == "tagged").subquery())) or 0
    return {"total_images": total, "passed": passed, "generated": generated, "tagged": tagged}


# ── Matrix (coverage matrix) ────────────────────────────────────────────────


@router.get("/matrix", dependencies=[Depends(require_scope("tags:read"))])
async def coverage_matrix(
    project_id: str,
    row: str = "scene",
    col: str = "season",
    db: AsyncSession = Depends(get_db),
):
    """Cell counts for `row × col` tag dimensions."""
    rows_q = (
        select(Tag.value, func.count(Tag.image_id))
        .join(Image, Tag.image_id == Image.id)
        .where(Image.project_id == project_id, Tag.dimension == row)
        .group_by(Tag.value)
    )
    cols_q = (
        select(Tag.value, func.count(Tag.image_id))
        .join(Image, Tag.image_id == Image.id)
        .where(Image.project_id == project_id, Tag.dimension == col)
        .group_by(Tag.value)
    )
    rows = [r[0] for r in (await db.execute(rows_q)).all()]
    cols = [c[0] for c in (await db.execute(cols_q)).all()]

    cell_q = (
        select(
            Tag.value.label("rv"),
            (
                select(Tag.value)
                .where(Tag.image_id == Image.id, Tag.dimension == col)
                .scalar_subquery()
            ).label("cv"),
            func.count(Image.id),
        )
        .join(Image, Tag.image_id == Image.id)
        .where(Image.project_id == project_id, Tag.dimension == row)
        .group_by("rv", "cv")
    )
    cells: dict[tuple[str, str], int] = {}
    for rv, cv, count in (await db.execute(cell_q)).all():
        if cv is None:
            continue
        cells[(rv, cv)] = count

    matrix = [[cells.get((rv, cv), 0) for cv in cols] for rv in rows]
    return {"rows": rows, "cols": cols, "matrix": matrix}


# ── Batches (read-only public surface) ──────────────────────────────────────


def _batch_public(b: BatchRun) -> dict:
    return {
        "id": b.id,
        "name": b.name,
        "task_type": b.task_type,
        "status": b.status,
        "total": b.total or 0,
        "completed": b.completed or 0,
        "failed": b.failed or 0,
        "skipped": b.skipped or 0,
        "cost_usd": float(b.cost_usd) if b.cost_usd is not None else 0.0,
        "started_at": b.started_at.isoformat() if b.started_at else None,
        "completed_at": b.completed_at.isoformat() if b.completed_at else None,
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


class BatchSubmitBody(BaseModel):
    name: str
    task_type: str
    seed_image_ids: List[str]
    prompt_ids: List[str]
    project_id: str
    concurrency: int = 10
    max_retry: int = 3
    budget_usd: Optional[float] = None


@router.get("/batches", dependencies=[Depends(require_scope("batches:read"))])
async def list_batches_public(
    project_id: Optional[str] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(BatchRun).order_by(BatchRun.created_at.desc())
    if project_id:
        q = q.where(BatchRun.project_id == project_id)
    if status:
        q = q.where(BatchRun.status == status)
    rows = await db.execute(q)
    return [_batch_public(b) for b in rows.scalars().all()]


@router.get("/batches/{batch_id}", dependencies=[Depends(require_scope("batches:read"))])
async def get_batch_public(batch_id: str, db: AsyncSession = Depends(get_db)):
    b = await db.get(BatchRun, batch_id)
    if not b:
        raise HTTPException(404, "BatchRun not found")
    return _batch_public(b)


@router.post("/batches", dependencies=[Depends(require_scope("batches:write"))])
async def submit_batch_public(body: BatchSubmitBody, db: AsyncSession = Depends(get_db)):
    """Scope: generate:write — most H5 keys should not be granted this."""
    if not body.seed_image_ids or not body.prompt_ids:
        raise HTTPException(400, "seed_image_ids and prompt_ids must be non-empty")
    batch = BatchRun(
        project_id=body.project_id,
        name=body.name,
        task_type=body.task_type,
        seed_image_ids=body.seed_image_ids,
        prompt_ids=body.prompt_ids,
        total=len(body.seed_image_ids) * len(body.prompt_ids),
        status="pending",
        concurrency=body.concurrency,
        max_retry=body.max_retry,
        budget_usd=body.budget_usd,
    )
    db.add(batch)
    await db.commit()
    await db.refresh(batch)
    await batch_scheduler.start_batch(batch.id)
    return _batch_public(batch)


# ── Text → Image match (S5.3 core endpoint) ─────────────────────────────────


class MatchFiltersBody(BaseModel):
    scene: Optional[List[str]] = None
    facility: Optional[List[str]] = None
    season: Optional[List[str]] = None
    weather: Optional[List[str]] = None
    angle: Optional[List[str]] = None
    people: Optional[List[str]] = None
    usage: Optional[List[str]] = None
    exclude_tags: Optional[dict] = None    # { dimension: [values] }
    source_type: Optional[str] = None
    project_id: Optional[str] = None
    folder_prefix: Optional[str] = None


class MatchScopeBody(BaseModel):
    """How candidates should be distributed across projects.

    `primary_project_id` is the call's home project (typically derived from
    the API key's binding; the playground passes the operator's currently
    selected project). The auto-quota algorithm gives this project at least
    75% of slots and only lets other projects in when the text is genuinely
    relevant to them.

    `force_single_project` is a debug-only override that disables all
    cross-project leakage. The playground exposes this as 「强制单项目」.
    """
    primary_project_id: Optional[str] = None
    force_single_project: Optional[bool] = False


class MatchBody(BaseModel):
    text: str
    limit: int = 8
    filters: Optional[MatchFiltersBody] = None
    scope: Optional[MatchScopeBody] = None
    strategy: Optional[str] = "balanced"   # precise | balanced | diverse
    weights: Optional[dict] = None          # override preset
    diversity: Optional[str] = "balanced"  # strict | balanced | none


def _public_url_for_match(image_id: str, cdn_path: str | None) -> tuple[str, str]:
    storage = get_storage()
    if cdn_path and storage.is_configured():
        original = storage.public_url(cdn_path)
        thumb = storage.public_url(object_key_for(image_id, "thumb_300", "jpg"))
        return original, thumb
    return (
        f"/open-api/v1/images/{image_id}/file",
        f"/open-api/v1/images/{image_id}/file?size=300",
    )


@router.post("/images/match", dependencies=[Depends(require_scope("images:match"))])
async def match_images(body: MatchBody):
    """Match a piece of text against the image library.

    Returns up to `limit` images ranked by:
      - cross-modal embedding similarity (Ark vision, same space as text)
      - tag dimension hits extracted from the text via jieba + tag schema
      - blur quality, business rules, diversity

    See match_strategy.STRATEGY_PRESETS for weight defaults; pass
    `weights` to override per-call.
    """
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_request", "message": "text is required"},
        )
    limit = max(1, min(int(body.limit or 8), int(get_setting("match_max_limit") or 50)))

    f = body.filters or MatchFiltersBody()
    filters = MatchFilters(
        scene=f.scene or [],
        facility=f.facility or [],
        season=f.season or [],
        weather=f.weather or [],
        angle=f.angle or [],
        people=f.people or [],
        usage=f.usage or [],
        exclude_tags=f.exclude_tags or {},
        source_type=f.source_type,
        project_id=f.project_id,         # legacy hard scope
        folder_prefix=f.folder_prefix,
    )
    s = body.scope or MatchScopeBody()
    scope = MatchScope(
        # Legacy fallback: a caller that still uses filters.project_id (e.g.
        # the old playground) gets it auto-promoted to scope.primary_project_id
        # so the multi-shard auto-quota path takes over instead of the
        # single-shard hard scope.
        primary_project_id=s.primary_project_id or filters.project_id,
        force_single_project=bool(s.force_single_project),
    )

    import time as _time
    t0 = _time.perf_counter()
    matches, debug = await match_text_to_images(
        text,
        limit=limit,
        filters=filters,
        scope=scope,
        strategy=body.strategy or "balanced",
        weights_override=body.weights,
        diversity_mode=body.diversity or "balanced",
    )
    took_ms = int((_time.perf_counter() - t0) * 1000)

    out: list[dict] = []
    for rank, m in enumerate(matches, start=1):
        url, thumb = _public_url_for_match(m.id, m.cdn_path)
        out.append({
            "image_id": m.id,
            "rank": rank,
            "score": round(m.score, 4),
            "score_breakdown": {k: round(v, 4) for k, v in m.score_breakdown.items()},
            "embedding_sim": round(m.embedding_sim, 4),
            "matched_tags": m.matched_tags,
            "url": url,
            "thumbnail_url": thumb,
            "cdn_synced": bool(m.cdn_path),
            "file_name": m.file_name,
            "width": m.width,
            "height": m.height,
            "source_type": m.source_type,
            "description": m.description,
            "tags": m.tags_by_dim,
            "project_id": m.project_id,
            "is_primary_project": m.is_primary_project,
        })
    response = {
        "matches": out,
        "took_ms": took_ms,
        "debug": debug,    # tokens / tag_hits / recall counts (caller can ignore)
    }
    # Surface the auto-quota decision to the caller so UGC can show
    # 「为你推荐」/「相关推荐」badges per slot, and ops can audit splits.
    if "scope_decision" in debug:
        response["scope_decision"] = debug["scope_decision"]
    return response


# ── Match feedback ──────────────────────────────────────────────────────────


class TrackUsageBody(BaseModel):
    request_id: Optional[str] = None
    text: Optional[str] = None              # original query (sha256'd, not stored raw)
    rank: Optional[int] = None
    score: Optional[float] = None
    was_chosen: bool = True


@router.post("/images/{image_id}/track-usage", dependencies=[Depends(require_scope("images:match"))])
async def track_usage(image_id: str, body: TrackUsageBody, db: AsyncSession = Depends(get_db)):
    """UGC client reports that an image was chosen / displayed. Drives
    precision telemetry and (later) weight tuning.

    Idempotency: client SHOULD pass request_id so duplicates can be merged
    in analysis. Server stores every call as a separate row to keep the
    write hot path fast.
    """
    import hashlib
    text_hash = ""
    if body.text:
        text_hash = hashlib.sha256(body.text.encode("utf-8", errors="replace")).hexdigest()[:16]

    # Resolve api_key_id from request scope; AuthMiddleware attaches it.
    # Pull via FastAPI Request? simpler — we don't currently have it here.
    # Acceptable to leave as None for now; admin can join via image_id.
    db.add(MatchFeedback(
        request_id=body.request_id,
        api_key_id=None,
        text_hash=text_hash,
        image_id=image_id,
        rank=body.rank,
        score=body.score,
        was_chosen=bool(body.was_chosen),
    ))
    await db.commit()
    return {"ok": True}


class SimilarBody(BaseModel):
    seed_image_id: str
    limit: int = 8
    filters: Optional[MatchFiltersBody] = None
    diversity: Optional[str] = "balanced"


@router.post("/images/similar", dependencies=[Depends(require_scope("images:match"))])
async def find_similar_images(body: SimilarBody, db: AsyncSession = Depends(get_db)):
    """Find images visually similar to a seed. Reuses the same embedding
    matrix and post-processing pipeline as /images/match — only the query
    vector source differs (image embedding instead of text embedding).
    """
    from sidecar.engines.clip_embed import deserialize_vector
    from sidecar.engines.text_search import index_cache
    import numpy as np
    import time as _time

    seed = await db.get(Image, body.seed_image_id)
    if not seed:
        raise HTTPException(404, detail={"code": "not_found", "message": "seed image not found"})
    qv = deserialize_vector(seed.embedding)
    if qv is None:
        raise HTTPException(
            422, detail={"code": "no_embedding",
                         "message": "seed image has no embedding; run pipeline → 向量化 first"},
        )

    limit = max(1, min(int(body.limit or 8), 50))
    f = body.filters or MatchFiltersBody()
    project_id = f.project_id or seed.project_id

    t0 = _time.perf_counter()
    shard = await index_cache.get_or_build(project_id)
    if not shard:
        raise HTTPException(422, detail={"code": "no_index", "message": "no embeddings in library"})
    if qv.size != shard.dim:
        raise HTTPException(
            422, detail={"code": "dim_mismatch",
                         "message": f"seed dim {qv.size} != library dim {shard.dim} — re-embed library"},
        )
    n = float(np.linalg.norm(qv))
    if n == 0:
        raise HTTPException(422, detail={"code": "zero_vector", "message": "seed embedding is degenerate"})
    qv_norm = (qv / n).astype(np.float32)

    sims = shard.matrix @ qv_norm
    # Pull more than `limit` so we can drop the seed itself + apply diversity
    k = min(limit * 4 + 1, sims.shape[0])
    idx = np.argpartition(-sims, k - 1)[:k]
    idx = idx[np.argsort(-sims[idx])]

    # Build candidates (skip the seed itself) and reuse the enrich/score path
    from sidecar.engines.match_strategy import MatchFilters, _apply_diversity, _build_matched_image, _enrich_and_filter, resolve_weights

    candidates: dict[str, dict] = {}
    for i in idx:
        iid = shard.image_ids[i]
        if iid == body.seed_image_id:
            continue
        candidates[iid] = {
            "id": iid,
            "embedding_sim": float(sims[i]),
            "kw_score": 0.0,
            "rrf_score": 0.0,
        }
        if len(candidates) >= limit * 4:
            break

    filters = MatchFilters(
        scene=f.scene or [], facility=f.facility or [], season=f.season or [],
        weather=f.weather or [], angle=f.angle or [], people=f.people or [],
        usage=f.usage or [], exclude_tags=f.exclude_tags or {},
        source_type=f.source_type, project_id=project_id, folder_prefix=f.folder_prefix,
    )
    enriched = await _enrich_and_filter(list(candidates.keys()), candidates, filters)

    # Score = embedding only; diversity post-pass keeps results varied
    weights = resolve_weights("precise", None)
    quality_max = max((row.get("blur_score") or 0.0) for row in enriched) or 1.0
    for row in enriched:
        emb = float(row.get("embedding_sim") or 0.0)
        blur = float(row.get("blur_score") or 0.0)
        biz = 1.0 if row.get("source_type") == "original" else 0.5
        row["score"] = emb * 0.85 + (blur / quality_max) * 0.10 + biz * 0.05
        row["score_breakdown"] = {"embedding": emb, "quality": blur / quality_max, "business": biz}
        row["matched_tag_pairs"] = []
    enriched.sort(key=lambda r: r["score"], reverse=True)
    final = _apply_diversity(enriched, limit=limit, mode=body.diversity or "balanced", weights=weights)
    matches = [_build_matched_image(r) for r in final]

    out: list[dict] = []
    for rank, m in enumerate(matches, start=1):
        url, thumb = _public_url_for_match(m.id, m.cdn_path)
        out.append({
            "image_id": m.id,
            "rank": rank,
            "score": round(m.score, 4),
            "embedding_sim": round(m.embedding_sim, 4),
            "url": url,
            "thumbnail_url": thumb,
            "cdn_synced": bool(m.cdn_path),
            "file_name": m.file_name,
            "width": m.width,
            "height": m.height,
            "source_type": m.source_type,
            "description": m.description,
            "tags": m.tags_by_dim,
        })
    return {
        "seed_image_id": body.seed_image_id,
        "matches": out,
        "took_ms": int((_time.perf_counter() - t0) * 1000),
    }


@router.get("/match/strategies")
async def list_strategies():
    """Static list of strategy presets the client can pick from."""
    return {
        "presets": [
            {"id": k, "weights": v.as_dict()}
            for k, v in STRATEGY_PRESETS.items()
        ]
    }
