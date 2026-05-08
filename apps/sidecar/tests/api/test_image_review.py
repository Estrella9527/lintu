"""Image review queue endpoints — pending → approved/rejected/skipped flow.

Covers the P0-06 review queue: enqueue, count, decide.
"""
from __future__ import annotations


def test_review_counts_empty(client, sample_project):
    r = client.get(f"/api/image-review/counts?project_id={sample_project}")
    assert r.status_code == 200
    body = r.json()
    for k in ("pending", "approved", "rejected", "skipped"):
        assert body.get(k, 0) == 0


def test_review_queue_invalid_status(client):
    r = client.get("/api/image-review/queue?status=banana")
    assert r.status_code == 400


def test_review_decide_invalid(client):
    r = client.post("/api/image-review/decide", json={
        "image_ids": ["nonexistent"],
        "decision": "maybe",
    })
    assert r.status_code == 400


def test_review_decide_no_ids_is_noop(client):
    """Empty image_ids should be a clean no-op (no 5xx, no DB churn)."""
    r = client.post("/api/image-review/decide", json={
        "image_ids": [],
        "decision": "approved",
    })
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    assert body.get("updated") == 0
