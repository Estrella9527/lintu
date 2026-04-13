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
    # Mask sensitive keys
    safe = {}
    for k, v in config.items():
        if "key" in k.lower() or "secret" in k.lower():
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
