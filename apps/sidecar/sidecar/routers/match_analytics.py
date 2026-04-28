"""Aggregations over match_feedback + ApiRequestLog for the
DistributionCenter "匹配分析" tab.

Exposes:
    GET /api/match/analytics?window_hours=168
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path as _Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import ApiRequestLog, MatchFeedback
from sidecar.db.session import get_db

router = APIRouter()


# ── Eval dataset ideal-answer marking ──────────────────────────────────────
#
# Reads/writes apps/sidecar/tests/match/eval_dataset.json. Lets the
# MatchPlayground UI mark a result as an ideal answer for a query without
# the operator having to copy image_ids by hand.
EVAL_DATASET_PATH = (
    _Path(__file__).resolve().parents[2] / "tests" / "match" / "eval_dataset.json"
)


def _load_eval_dataset() -> dict:
    if not EVAL_DATASET_PATH.exists():
        raise HTTPException(404, "eval_dataset.json not found")
    return json.loads(EVAL_DATASET_PATH.read_text(encoding="utf-8"))


def _save_eval_dataset(data: dict) -> None:
    EVAL_DATASET_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


@router.get("/eval/queries")
async def list_eval_queries():
    """Return the eval-dataset queries so the playground can suggest a
    target query when its current text matches one verbatim."""
    data = _load_eval_dataset()
    return {
        "version": data.get("version"),
        "queries": [
            {
                "id": q.get("id"),
                "text": q.get("text"),
                "tags": q.get("tags") or [],
                "ideal_image_ids": q.get("ideal_image_ids") or [],
            }
            for q in (data.get("queries") or [])
        ],
    }


class EvalIdealBody(BaseModel):
    query_id: str
    image_id: str
    action: str = "add"   # "add" | "remove"


@router.post("/eval/ideal")
async def mark_ideal_answer(body: EvalIdealBody):
    """Toggle an image_id in a query's ideal_image_ids set."""
    if body.action not in ("add", "remove"):
        raise HTTPException(400, "action must be 'add' or 'remove'")
    data = _load_eval_dataset()
    queries = data.get("queries") or []
    target = next((q for q in queries if q.get("id") == body.query_id), None)
    if target is None:
        raise HTTPException(404, f"query_id '{body.query_id}' not in dataset")
    ids = list(target.get("ideal_image_ids") or [])
    if body.action == "add":
        if body.image_id not in ids:
            ids.append(body.image_id)
    else:
        ids = [i for i in ids if i != body.image_id]
    target["ideal_image_ids"] = ids
    _save_eval_dataset(data)
    return {"ok": True, "query_id": body.query_id, "ideal_image_ids": ids}


# ── Maintenance: backfill text_search_blob (admin only) ────────────────────


@router.post("/backfill-text-search")
async def backfill_text_search_endpoint(db: AsyncSession = Depends(get_db)):
    """Refresh Image.text_search_blob for every row from current
    description + tags. Run after a tagger re-run with the new schema.

    Streams progress to logs; returns summary at the end. For 10k images
    expect ~20-40 seconds.
    """
    from pathlib import Path
    from sqlalchemy import select, update
    from sidecar.db.models import Image, Tag

    BATCH = 500
    offset = 0
    updated = 0

    while True:
        rows = (await db.execute(
            select(Image.id, Image.file_name, Image.description)
            .order_by(Image.id).offset(offset).limit(BATCH)
        )).all()
        if not rows:
            break
        ids = [r[0] for r in rows]
        tag_rows = (await db.execute(
            select(Tag.image_id, Tag.value).where(Tag.image_id.in_(ids))
        )).all()
        tags_by_img: dict[str, list[str]] = {}
        for img_id, val in tag_rows:
            tags_by_img.setdefault(img_id, []).append(val)
        for img_id, file_name, description in rows:
            parts = []
            if file_name:
                parts.append(Path(file_name).stem.replace("_", " "))
            if description and description.strip():
                parts.append(description.strip())
            tvs = tags_by_img.get(img_id) or []
            if tvs:
                parts.append(", ".join(tvs))
            await db.execute(
                update(Image).where(Image.id == img_id).values(text_search_blob="\n".join(parts))
            )
            updated += 1
        await db.commit()
        offset += BATCH

    # text_search relies on this blob — invalidate the in-memory shard so
    # next /match request rebuilds. (Embedding shard not affected.)
    return {"ok": True, "updated": updated}


@router.get("/analytics")
async def match_analytics(
    window_hours: int = 168,
    db: AsyncSession = Depends(get_db),
):
    """High-level match KPIs over the last N hours (default 7 days)."""
    window_hours = max(1, min(int(window_hours), 24 * 90))   # cap at 90 days
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)

    # ── Match call volume + latency from ApiRequestLog ──────────────────────
    match_path = "/open-api/v1/images/match"
    log_q = (
        select(ApiRequestLog)
        .where(ApiRequestLog.path == match_path)
        .where(ApiRequestLog.created_at >= cutoff)
    )
    log_rows = (await db.execute(log_q)).scalars().all()
    call_count = len(log_rows)
    err_count = sum(1 for r in log_rows if (r.status_code or 0) >= 400)
    latencies = sorted([r.latency_ms or 0 for r in log_rows])
    avg_lat = int(sum(latencies) / max(1, len(latencies))) if latencies else 0
    p50_lat = latencies[len(latencies) // 2] if latencies else 0
    p95_lat = latencies[int(len(latencies) * 0.95)] if latencies else 0

    # ── Feedback breakdown from match_feedback ──────────────────────────────
    fb_rows = (
        await db.execute(
            select(MatchFeedback).where(MatchFeedback.created_at >= cutoff)
        )
    ).scalars().all()
    fb_count = len(fb_rows)
    chosen_count = sum(1 for r in fb_rows if r.was_chosen)

    # Unique queries (by text_hash); chosen rate = queries with ≥1 chosen / total queries
    seen_q: set[str] = set()
    chosen_q: set[str] = set()
    for r in fb_rows:
        if r.text_hash:
            seen_q.add(r.text_hash)
            if r.was_chosen:
                chosen_q.add(r.text_hash)
    unique_queries = len(seen_q)
    chosen_rate = (len(chosen_q) / unique_queries) if unique_queries > 0 else 0.0

    # Average rank of chosen images (lower = better; ideal is 1)
    chosen_ranks = [r.rank for r in fb_rows if r.was_chosen and r.rank is not None]
    avg_chosen_rank = (sum(chosen_ranks) / len(chosen_ranks)) if chosen_ranks else None

    # ── Daily timeseries — last N days ───────────────────────────────────────
    days = max(1, (window_hours + 23) // 24)
    by_day: dict[str, dict[str, int]] = {}
    for r in log_rows:
        if not r.created_at:
            continue
        d = r.created_at.strftime("%Y-%m-%d")
        if d not in by_day:
            by_day[d] = {"calls": 0, "errors": 0}
        by_day[d]["calls"] += 1
        if (r.status_code or 0) >= 400:
            by_day[d]["errors"] += 1
    fb_by_day: dict[str, int] = {}
    for r in fb_rows:
        if not r.created_at or not r.was_chosen:
            continue
        d = r.created_at.strftime("%Y-%m-%d")
        fb_by_day[d] = fb_by_day.get(d, 0) + 1
    timeseries = []
    today = datetime.utcnow().date()
    for i in range(days):
        d = (today - timedelta(days=days - 1 - i)).isoformat()
        bd = by_day.get(d, {"calls": 0, "errors": 0})
        timeseries.append({
            "date": d,
            "calls": bd["calls"],
            "errors": bd["errors"],
            "chosen": fb_by_day.get(d, 0),
        })

    # ── "Hard queries" — queries with multiple shows but no chosen ──────────
    # Group feedback by text_hash; surface those with high impressions and
    # zero chosen — these are the queries the library can't satisfy.
    impressions: dict[str, int] = {}
    chosen_hits: dict[str, int] = {}
    sample_text_for_hash: dict[str, str] = {}     # we don't store raw text;
    # leave a placeholder — UI can show "hash xxxx (复制日志详情)"
    for r in fb_rows:
        if not r.text_hash:
            continue
        impressions[r.text_hash] = impressions.get(r.text_hash, 0) + 1
        if r.was_chosen:
            chosen_hits[r.text_hash] = chosen_hits.get(r.text_hash, 0) + 1

    hard_queries = []
    for h, n in impressions.items():
        if n >= 2 and chosen_hits.get(h, 0) == 0:
            hard_queries.append({
                "text_hash": h,
                "impressions": n,
                "chosen": 0,
            })
    hard_queries.sort(key=lambda x: -x["impressions"])
    hard_queries = hard_queries[:20]

    # Reverse-lookup: walk match request logs in the same window and recover
    # the raw query text for each hash. We hash on the way in so this is
    # cheap (sha256 of small strings).
    if hard_queries:
        import hashlib
        wanted = {q["text_hash"] for q in hard_queries}
        text_for_hash: dict[str, str] = {}
        for r in log_rows:
            if r.path != match_path or not r.request_body:
                continue
            body = r.request_body if isinstance(r.request_body, dict) else {}
            t = body.get("text") if isinstance(body.get("text"), str) else None
            if not t:
                continue
            h = hashlib.sha256(t.encode("utf-8")).hexdigest()[:16]
            if h in wanted and h not in text_for_hash:
                text_for_hash[h] = t
                if len(text_for_hash) == len(wanted):
                    break
        for q in hard_queries:
            q["sample_text"] = text_for_hash.get(q["text_hash"])

    return {
        "window_hours": window_hours,
        "calls": {
            "total": call_count,
            "errors": err_count,
            "error_rate": (err_count / call_count) if call_count > 0 else 0,
        },
        "latency_ms": {
            "avg": avg_lat,
            "p50": p50_lat,
            "p95": p95_lat,
        },
        "feedback": {
            "total_events": fb_count,
            "chosen_events": chosen_count,
            "unique_queries": unique_queries,
            "chosen_query_rate": chosen_rate,
            "avg_chosen_rank": avg_chosen_rank,
        },
        "timeseries": timeseries,
        "hard_queries": hard_queries,
    }
