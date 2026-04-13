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


@router.put("")
async def update_config(body: UpdateConfigBody):
    config = _read_config()
    config.update(body.data)
    _write_config(config)
    return {"ok": True}
