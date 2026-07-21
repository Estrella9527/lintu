from __future__ import annotations

import json

import httpx

from sidecar.routers import providers


class _FakeAsyncClient:
    def __init__(self, *, models: list[str], call_status: int, call_body: dict):
        self.models = models
        self.call_status = call_status
        self.call_body = call_body
        self.post_json = None
        self.post_headers = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, *, headers):
        request = httpx.Request("GET", url)
        return httpx.Response(
            200,
            request=request,
            json={"data": [{"id": model} for model in self.models]},
        )

    async def post(self, url, *, headers, json):
        self.post_headers = headers
        self.post_json = json
        request = httpx.Request("POST", url)
        return httpx.Response(
            self.call_status,
            request=request,
            json=self.call_body,
        )


async def test_openai_test_uses_real_selected_model_and_vision_call(monkeypatch):
    fake = _FakeAsyncClient(
        models=["gpt-5.4-pro"],
        call_status=403,
        call_body={"error": {"message": "该令牌无权访问模型 gpt-5.5"}},
    )
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: fake)

    result = await providers._test_openai_compatible(
        "https://relay.example", "correct-token", "gpt-5.5"
    )

    assert result["ok"] is False
    assert "真实视觉调用失败（HTTP 403）" in result["error"]
    assert "gpt-5.4-pro" in result["error"]
    assert fake.post_headers["Authorization"] == "Bearer correct-token"
    assert fake.post_json["model"] == "gpt-5.5"
    content = fake.post_json["messages"][0]["content"]
    assert any(item.get("type") == "image_url" for item in content)


async def test_provider_name_resolves_same_saved_relay_as_runtime(monkeypatch):
    monkeypatch.setattr(
        providers,
        "_read_config",
        lambda: {
            "custom_relays": json.dumps([
                {"name": "first", "base_url": "https://first", "api_key": "first-key", "model": "first-model"},
                {"name": "wanted", "base_url": "https://wanted", "api_key": "wanted-key", "model": "wanted-model"},
            ])
        },
    )
    captured = {}

    async def fake_test(base_url, api_key, model):
        captured.update(base_url=base_url, api_key=api_key, model=model)
        return {"ok": True}

    monkeypatch.setattr(providers, "_test_openai_compatible", fake_test)
    result = await providers.test_provider(
        providers.TestProviderBody(
            provider_id="openai_compatible",
            provider_name="wanted",
            relay_index=0,  # stale index must not win over stable identity
        )
    )

    assert result == {"ok": True}
    assert captured == {
        "base_url": "https://wanted",
        "api_key": "wanted-key",
        "model": "wanted-model",
    }
