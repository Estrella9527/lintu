"""Run the eval dataset against /open-api/v1/images/match and emit a markdown report.

Usage:
    cd apps/sidecar
    uv run python scripts/eval_match.py                          # run all annotated queries
    uv run python scripts/eval_match.py --strategy precise       # try alt strategy
    uv run python scripts/eval_match.py --output report.md       # custom output path
    uv run python scripts/eval_match.py --skip-unannotated       # skip queries without ideal_image_ids
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
DATASET_PATH = REPO_ROOT / "apps" / "sidecar" / "tests" / "match" / "eval_dataset.json"
DEFAULT_API = "http://127.0.0.1:7879"
DEFAULT_LIMIT = 12        # Top-12 → covers Recall@1/3/5/8/12


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--strategy", default="balanced", choices=["precise", "balanced", "diverse"])
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--output", default=None, help="Markdown output path (default: docs/eval_<ts>_<strategy>.md)")
    parser.add_argument("--skip-unannotated", action="store_true",
                        help="Only score queries with ideal_image_ids; otherwise list all results for manual annotation")
    args = parser.parse_args()

    if not DATASET_PATH.exists():
        print(f"dataset not found: {DATASET_PATH}", file=sys.stderr)
        return 1

    data = json.loads(DATASET_PATH.read_text())
    queries = data.get("queries", [])
    print(f"loaded {len(queries)} queries from {DATASET_PATH.name}")

    # Run + score
    rows: list[dict] = []
    latencies: list[int] = []
    for q in queries:
        ideal = set(q.get("ideal_image_ids") or [])
        if args.skip_unannotated and not ideal:
            continue
        result = _run_match(args.api, q["text"], args.strategy, args.limit)
        if not result:
            rows.append({"q": q, "error": "request failed", "matches": [], "metrics": None})
            continue
        latencies.append(result["took_ms"])
        matches = result["matches"]
        if ideal:
            metrics = _score(matches, ideal, args.limit)
        else:
            metrics = None
        rows.append({"q": q, "matches": matches, "metrics": metrics, "took_ms": result["took_ms"], "debug": result.get("debug", {})})
        print(f"  {q['id']:>4}  took={result['took_ms']:>4}ms"
              + (f"  Recall@8={metrics['recall_at_8']:.2f}  MRR={metrics['mrr']:.3f}" if metrics else "  (unannotated)"))

    # Aggregate
    annotated = [r for r in rows if r.get("metrics")]
    summary: dict = {
        "strategy": args.strategy,
        "limit": args.limit,
        "total_queries": len(rows),
        "annotated_queries": len(annotated),
        "avg_latency_ms": int(statistics.mean(latencies)) if latencies else 0,
        "p95_latency_ms": int(_p95(latencies)) if latencies else 0,
    }
    if annotated:
        summary["mean_recall_at_1"] = statistics.mean(r["metrics"]["recall_at_1"] for r in annotated)
        summary["mean_recall_at_3"] = statistics.mean(r["metrics"]["recall_at_3"] for r in annotated)
        summary["mean_recall_at_5"] = statistics.mean(r["metrics"]["recall_at_5"] for r in annotated)
        summary["mean_recall_at_8"] = statistics.mean(r["metrics"]["recall_at_8"] for r in annotated)
        summary["mean_recall_at_12"] = statistics.mean(r["metrics"]["recall_at_12"] for r in annotated)
        summary["mean_mrr"] = statistics.mean(r["metrics"]["mrr"] for r in annotated)

    # Write markdown report
    out_path = Path(args.output) if args.output else (
        REPO_ROOT / "docs" / f"eval_{datetime.now().strftime('%Y%m%d_%H%M')}_{args.strategy}.md"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(_render_markdown(summary, rows))
    print(f"\nreport: {out_path}")
    return 0


def _run_match(api: str, text: str, strategy: str, limit: int) -> dict | None:
    try:
        t0 = time.perf_counter()
        # Force-bypass any HTTP_PROXY env vars — match endpoint is on
        # localhost and going through a proxy would just fail.
        r = requests.post(
            f"{api}/open-api/v1/images/match",
            json={"text": text, "limit": limit, "strategy": strategy},
            timeout=30,
            proxies={"http": "", "https": ""},
        )
        r.raise_for_status()
        d = r.json()
        d.setdefault("took_ms", int((time.perf_counter() - t0) * 1000))
        return d
    except Exception as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        return None


def _score(matches: list, ideal: set[str], limit: int) -> dict:
    """Recall@K + MRR + first-hit rank."""
    ideal = set(ideal)
    n_ideal = max(1, len(ideal))
    hits_in_top = {k: 0 for k in (1, 3, 5, 8, 12)}
    first_hit_rank = None
    for i, m in enumerate(matches[:limit], start=1):
        if m["image_id"] in ideal:
            for k in (1, 3, 5, 8, 12):
                if i <= k:
                    hits_in_top[k] += 1
            if first_hit_rank is None:
                first_hit_rank = i
    return {
        "recall_at_1": hits_in_top[1] / n_ideal,
        "recall_at_3": hits_in_top[3] / n_ideal,
        "recall_at_5": hits_in_top[5] / n_ideal,
        "recall_at_8": hits_in_top[8] / n_ideal,
        "recall_at_12": hits_in_top[12] / n_ideal,
        "mrr": (1.0 / first_hit_rank) if first_hit_rank else 0.0,
        "first_hit_rank": first_hit_rank,
        "ideal_count": len(ideal),
        "hits_in_top12": hits_in_top[12],
    }


def _p95(values: list[int]) -> float:
    if not values:
        return 0
    s = sorted(values)
    idx = max(0, int(len(s) * 0.95) - 1)
    return s[idx]


def _render_markdown(summary: dict, rows: list[dict]) -> str:
    lines: list[str] = []
    lines.append(f"# Match Evaluation Report — strategy `{summary['strategy']}`")
    lines.append("")
    lines.append(f"Generated: {datetime.now().isoformat(timespec='seconds')}")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- **Total queries**: {summary['total_queries']} ({summary['annotated_queries']} annotated)")
    lines.append(f"- **Latency**: avg {summary['avg_latency_ms']}ms · P95 {summary['p95_latency_ms']}ms")
    if summary.get("mean_recall_at_8") is not None:
        lines.append("")
        lines.append("| Metric | Value |")
        lines.append("|---|---|")
        for k in ("recall_at_1", "recall_at_3", "recall_at_5", "recall_at_8", "recall_at_12", "mrr"):
            v = summary.get(f"mean_{k}")
            if v is not None:
                lines.append(f"| Mean {k.replace('_', ' ').title()} | {v:.3f} |")
    else:
        lines.append("")
        lines.append("> ⚠️ No annotated queries — all `ideal_image_ids` are empty. Open the report, "
                     "manually pick the best matches per query (copy `image_id` from the rendered list), "
                     "and paste them into `tests/match/eval_dataset.json` to enable scoring.")
    lines.append("")
    lines.append("---")
    lines.append("")

    # Per-query detail
    lines.append("## Per-query results")
    lines.append("")
    for r in rows:
        q = r["q"]
        lines.append(f"### {q['id']} · `{q['text']}`")
        lines.append("")
        if q.get("tags"):
            lines.append(f"**Tags**: {', '.join(q['tags'])}")
        m = r.get("metrics")
        if m:
            lines.append(f"**Score**: Recall@8={m['recall_at_8']:.2f}  MRR={m['mrr']:.3f}  "
                         f"hits {m['hits_in_top12']}/{m['ideal_count']} in top-12  "
                         f"first hit @ {m['first_hit_rank']}")
        else:
            lines.append("**Status**: 未标注（在下方列表中复制 image_id 填到 dataset 后再跑分）")
        lines.append("")
        if r.get("error"):
            lines.append(f"❌ {r['error']}")
        elif r.get("matches"):
            ideal = set(q.get("ideal_image_ids") or [])
            lines.append("| Rank | image_id | Score | matched_tags | description |")
            lines.append("|---|---|---|---|---|")
            for m in r["matches"]:
                marker = "⭐ " if m["image_id"] in ideal else ""
                tags_str = " · ".join(t["value"] for t in m.get("matched_tags", []))[:60]
                desc = (m.get("description") or "").replace("|", "/")[:80]
                lines.append(
                    f"| {m['rank']} | {marker}`{m['image_id']}` | {m['score']:.3f} | {tags_str} | {desc} |"
                )
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
