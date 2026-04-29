import json
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from sidecar.config import DATA_DIR

router = APIRouter()

CONFIG_FILE = DATA_DIR / "config.json"


def _read_config() -> dict:
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text())
    return {}


def _write_config(data: dict):
    CONFIG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


class UpdateConfigBody(BaseModel):
    data: dict


@router.get("")
async def get_config():
    config = _read_config()
    # Mask sensitive keys (only mask string values that look like secrets)
    safe = {}
    for k, v in config.items():
        if not isinstance(v, str):
            safe[k] = v
        elif k == "custom_relays":
            # Mask api_key inside relay entries but keep structure
            try:
                relays = json.loads(v)
                for r in relays:
                    if "api_key" in r and len(r["api_key"]) > 4:
                        r["api_key"] = r["api_key"][:4] + "****"
                safe[k] = json.dumps(relays, ensure_ascii=False)
            except (json.JSONDecodeError, TypeError):
                safe[k] = v
        elif "key" in k.lower() or "secret" in k.lower():
            safe[k] = v[:4] + "****" if len(v) > 4 else "****"
        else:
            safe[k] = v
    return safe


def _looks_masked(value: str) -> bool:
    return isinstance(value, str) and "****" in value


@router.put("")
async def update_config(body: UpdateConfigBody):
    config = _read_config()
    incoming = dict(body.data)

    # Preserve existing secrets when caller sent the masked placeholder back.
    # The GET endpoint masks api_key / *_key / *_secret values; if the UI
    # round-trips them unchanged, we must NOT overwrite the real value.
    for k, v in list(incoming.items()):
        if k == "custom_relays" and isinstance(v, str):
            try:
                new_relays = json.loads(v)
                old_relays = json.loads(config.get("custom_relays", "[]"))
                old_by_name = {r.get("name"): r for r in old_relays if r.get("name")}
                for r in new_relays:
                    key = r.get("api_key", "")
                    if _looks_masked(key):
                        prev = old_by_name.get(r.get("name"))
                        if prev and prev.get("api_key"):
                            r["api_key"] = prev["api_key"]
                incoming[k] = json.dumps(new_relays, ensure_ascii=False)
            except (json.JSONDecodeError, TypeError):
                pass
        elif ("key" in k.lower() or "secret" in k.lower()) and _looks_masked(v):
            if k in config:
                incoming[k] = config[k]

    config.update(incoming)
    _write_config(config)

    # Notify subsystems that depend on cached config snapshots
    try:
        from sidecar.engines.oss_sync import invalidate_storage_cache
        invalidate_storage_cache()
    except ImportError:
        pass

    # Enqueue cloud sync so operator-tuned defaults (match strategy knobs,
    # provider config, etc) reach the cloud sidecar within 1s of saving here.
    # Only fires when LINTU_CLOUD_SYNC_URL is set; pure local mode is no-op.
    try:
        from sidecar.scheduler.cloud_sync_worker import (
            enqueue_config_replace, CLOUD_RELEVANT_CONFIG_KEYS,
        )
        if any(k in CLOUD_RELEVANT_CONFIG_KEYS for k in incoming):
            await enqueue_config_replace()
    except Exception:
        pass
    return {"ok": True}
