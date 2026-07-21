from __future__ import annotations

import json

from sidecar.routers import config_api


async def test_renaming_relay_does_not_replace_real_token_with_mask(monkeypatch):
    state = {
        "custom_relays": json.dumps([
            {
                "name": "old-name",
                "base_url": "https://relay.example",
                "api_key": "real-secret-token",
                "model": "vision-model",
            }
        ]),
        "__version": 3,
    }
    written = {}

    monkeypatch.setattr(config_api, "_read_config", lambda: dict(state))
    monkeypatch.setattr(config_api, "_write_config", lambda data: written.update(data))

    async def no_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(config_api, "_write_audit", no_audit)
    body = config_api.UpdateConfigBody(data={
        "custom_relays": json.dumps([
            {
                "name": "new-name",
                "base_url": "https://relay.example",
                "api_key": "real****",
                "model": "vision-model",
            }
        ])
    })

    result = await config_api.update_config(body)
    saved = json.loads(written["custom_relays"])
    assert result["ok"] is True
    assert saved[0]["name"] == "new-name"
    assert saved[0]["api_key"] == "real-secret-token"
