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


async def test_review_decide_batches_only_currently_pending_images(
    client, db_session, sample_project,
):
    """多选审批应一次处理多张待审图，且不能改写陈旧/已通过的选中项。"""
    from sidecar.db.models import Image

    pending_one = Image(
        project_id=sample_project,
        file_path="/tmp/pending-one.jpg",
        file_name="pending-one.jpg",
        review_status="pending",
        is_listed=True,
    )
    pending_two = Image(
        project_id=sample_project,
        file_path="/tmp/pending-two.jpg",
        file_name="pending-two.jpg",
        review_status="pending",
        is_listed=True,
    )
    already_approved = Image(
        project_id=sample_project,
        file_path="/tmp/already-approved.jpg",
        file_name="already-approved.jpg",
        review_status="approved",
        is_listed=True,
    )
    db_session.add_all([pending_one, pending_two, already_approved])
    await db_session.commit()

    response = client.post("/api/image-review/decide", json={
        "image_ids": [pending_one.id, pending_two.id, already_approved.id],
        "decision": "rejected",
    })

    assert response.status_code == 200
    assert response.json()["updated"] == 2
    await db_session.refresh(pending_one)
    await db_session.refresh(pending_two)
    await db_session.refresh(already_approved)
    assert pending_one.review_status == "rejected"
    assert pending_two.review_status == "rejected"
    assert pending_one.is_listed is False
    assert pending_two.is_listed is False
    assert already_approved.review_status == "approved"
    assert already_approved.is_listed is True
