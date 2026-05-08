"""ops flavor / LINTU_AUTH_BYPASS 行为验证。

走 user_auth.py 里的旁路分支：BUILD_FLAVOR=ops 或 LINTU_AUTH_BYPASS=1 时
所有 /api/* 请求自动获得 SYSTEM_ROOT 身份，无须 token。
"""
from __future__ import annotations


async def test_bypass_inject_root(client, monkeypatch):
    """conftest 里 LINTU_AUTH_BYPASS=1，所以默认就在旁路模式 — 直接调
    /api/auth/me 应返回 SYSTEM_ROOT 身份（is_root=True）。"""
    res = client.get("/api/auth/me")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("is_root") is True
    # SYSTEM_ROOT.id 是写死的 "system-root"
    assert body.get("id") == "system-root"


async def test_strict_mode_rejects_unauth(client, monkeypatch):
    """临时清掉 BYPASS（dev flavor 默认严格鉴权）→ 没 token 直接 401。"""
    monkeypatch.setenv("LINTU_AUTH_BYPASS", "0")
    res = client.get("/api/projects")
    assert res.status_code == 401
    body = res.json()
    assert body.get("detail", {}).get("code") == "unauthorized"


async def test_ops_flavor_bypasses_auth(client, monkeypatch):
    """模拟 ops 包：BUILD_FLAVOR=ops 不需要 token 即可。"""
    monkeypatch.setenv("LINTU_AUTH_BYPASS", "0")
    monkeypatch.setenv("LINTU_BUILD_FLAVOR", "ops")
    res = client.get("/api/auth/me")
    assert res.status_code == 200
    assert res.json().get("is_root") is True
