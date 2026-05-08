"""Smoke tests — every important endpoint returns 200 / known-good shape.

Goal of this file is **breadth, not depth**: catch the regressions that turn
the whole sidecar into a 500 generator (missing import, busted router mount,
schema column rename forgotten in payload). Per-endpoint deep behavior tests
live in their own files.

If one of these fails, the sidecar is broken and any UGC traffic is broken too.
"""
from __future__ import annotations

import json


def test_root(client):
    """The root path should always answer (returns service identifier)."""
    r = client.get("/")
    assert r.status_code in (200, 404), f"unexpected status {r.status_code}"


def test_openapi_v1_health(client):
    r = client.get("/open-api/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body.get("status") == "ok"


def test_match_strategies_list(client):
    """Strategy presets endpoint — must always return the 3 canonical presets."""
    r = client.get("/open-api/v1/match/strategies")
    assert r.status_code == 200
    presets = {p["id"] for p in r.json()["presets"]}
    assert presets == {"precise", "balanced", "diverse"}


def test_match_invalid_text_returns_400(client):
    r = client.post("/open-api/v1/images/match", json={"text": "  "})
    assert r.status_code == 400
    body = r.json()
    # Error envelope: AuditMiddleware wraps HTTPException.detail under "error".
    err = body.get("error") or body.get("detail") or {}
    assert err.get("code") == "invalid_request", f"unexpected body: {body}"


def test_match_empty_library_returns_empty(client):
    """With an empty image library, /match should still return 200 + an empty
    matches array (NOT 500). UGC depends on this graceful degradation."""
    r = client.post(
        "/open-api/v1/images/match",
        json={"text": "亲子游玩", "limit": 8, "scope": {"primary_project_id": "nonexistent"}},
    )
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body.get("matches"), list)
    assert body["matches"] == []


def test_config_get_returns_dict(client):
    """/api/config returns a dict (possibly empty), never null."""
    r = client.get("/api/config")
    assert r.status_code == 200
    assert isinstance(r.json(), dict)


def test_config_oss_test_unsupported_provider(client):
    """OSS test endpoint — unknown provider → 200 with ok=False, NOT 500."""
    r = client.post("/api/config/oss/test", json={
        "oss_provider": "fake-cloud",
        "oss_endpoint": "x", "oss_bucket": "y",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body.get("code") == "unsupported"


def test_match_strategies_full_shape(client):
    r = client.get("/open-api/v1/match/strategies")
    presets = r.json()["presets"]
    for preset in presets:
        weights = preset["weights"]
        for key in ("embedding", "tag", "quality", "diversity", "business"):
            assert key in weights, f"strategy {preset['id']} missing weight {key}"
            assert isinstance(weights[key], (int, float))
