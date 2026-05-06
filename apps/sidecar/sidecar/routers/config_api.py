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


# ── Recently-shown cooldown (per project) admin endpoints ───────────────────


@router.post("/match-cooldown/reset")
async def reset_match_cooldown(project_id: str | None = None):
    """Clear the server-side recent-shown cooldown buffer.
    Pass ?project_id=... to scope to one project; omit to wipe all.
    Useful after content changes or when debugging match results."""
    from sidecar.engines import recent_shown
    n = recent_shown.reset(project_id)
    return {"ok": True, "cleared": n, "project_id": project_id}


@router.get("/match-cooldown")
async def get_match_cooldown_state():
    """Inspect what the cooldown currently holds (debug endpoint)."""
    from sidecar.engines import recent_shown as _rs
    out = {}
    for pid, buf in _rs._buffers.items():
        out[pid or "(no-project)"] = {"size": len(buf), "max": buf.maxlen, "ids": list(buf)}
    return out


# ── Portable AI-provider export / import ────────────────────────────────────
# Operators bringing up a second machine want to copy provider config (relays,
# default model selections, embedding/general/parser pickers) over without
# re-clicking through every dropdown. These two endpoints handle that.

# The list of provider-related keys we ship in/out. Other config (data dir,
# upload policy, OSS, match defaults) is host-specific and intentionally
# excluded.
_PROVIDER_KEYS = (
    "custom_relays",
    "default_image_embedding_provider",
    "default_general_provider",
    "default_parser_provider",
    "general_provider_model",
    "parser_provider_model",
    "image_embedding_model_override",
    "image_output_size",
    "gemini_api_key",
    "openai_api_key",
    "qwen_api_key",
    "jimeng_api_key",
    "tongyi_wanxiang_api_key",
    "zhipu_api_key",
    "comfyui_url",
)


def _mask_secret(value: str) -> str:
    if not isinstance(value, str) or len(value) <= 4:
        return "****"
    return value[:4] + "****"


@router.get("/export-providers")
async def export_providers(include_secrets: bool = False):
    """Dump AI provider config as portable JSON.

    By default `api_key` values inside `custom_relays` and the bare
    `*_api_key` fields are masked (`sk-X****`). Pass `include_secrets=true`
    only when migrating between machines you fully trust — the response
    body becomes sensitive material.

    Field shape:
      { "_meta": {...}, "config": { "custom_relays": [...], ... } }
    """
    from datetime import datetime
    config = _read_config()
    subset: dict = {}
    for k in _PROVIDER_KEYS:
        if k not in config:
            continue
        v = config[k]
        if k == "custom_relays" and isinstance(v, str):
            try:
                relays = json.loads(v)
                if not include_secrets:
                    for r in relays:
                        if isinstance(r, dict) and r.get("api_key"):
                            r["api_key"] = _mask_secret(r["api_key"])
                subset[k] = json.dumps(relays, ensure_ascii=False)
            except (json.JSONDecodeError, TypeError):
                subset[k] = v
        elif (k.endswith("_api_key") or "secret" in k.lower()) and not include_secrets:
            subset[k] = _mask_secret(v) if isinstance(v, str) else v
        else:
            subset[k] = v
    return {
        "_meta": {
            "lintu_export_kind": "ai_providers",
            "version": 1,
            "include_secrets": bool(include_secrets),
            "exported_at": datetime.utcnow().isoformat() + "Z",
        },
        "config": subset,
    }


class ImportProvidersBody(BaseModel):
    config: dict = {}
    # mode='merge' (default): incoming keys overwrite same-named keys in
    # local config; for `custom_relays`, relays are merged by name (incoming
    # wins on collision but local-only relays are kept).
    # mode='replace': for each provider key in the import payload, blow away
    # the local value and adopt the incoming one. Use cautiously.
    mode: str = "merge"


@router.post("/import-providers")
async def import_providers(body: ImportProvidersBody):
    """Apply a previously-exported provider blob to this machine.

    Masked api_keys (`sk-X****` etc) in the incoming payload are skipped —
    the local value is preserved. So a machine that already has secrets
    stays secret-correct after a merge import from a redacted export.

    Returns counts: relays added/updated/kept, top-level keys touched.
    """
    incoming = dict(body.config or {})
    if not incoming:
        return {"ok": False, "error": "config 字段为空"}

    config = _read_config()
    relays_added = 0
    relays_updated = 0
    keys_touched = 0

    for k, v in incoming.items():
        if k not in _PROVIDER_KEYS:
            continue
        if k == "custom_relays":
            try:
                in_relays = json.loads(v) if isinstance(v, str) else v
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(in_relays, list):
                continue
            try:
                cur_relays = json.loads(config.get("custom_relays", "[]"))
            except (json.JSONDecodeError, TypeError):
                cur_relays = []
            cur_by_name = {r.get("name"): r for r in cur_relays if isinstance(r, dict) and r.get("name")}
            for r in in_relays:
                if not isinstance(r, dict) or not r.get("name"):
                    continue
                name = r["name"]
                # If incoming api_key is masked AND we have an existing one,
                # keep the existing real key. Otherwise adopt the new value.
                merged = dict(r)
                if "api_key" in merged and _looks_masked(merged["api_key"]):
                    prev = cur_by_name.get(name)
                    if prev and prev.get("api_key"):
                        merged["api_key"] = prev["api_key"]
                    else:
                        # No existing key, and incoming is masked → drop it; user
                        # will need to fill in via the UI later.
                        merged.pop("api_key", None)
                if name in cur_by_name:
                    if body.mode == "replace":
                        cur_by_name[name] = merged
                    else:
                        cur_by_name[name] = {**cur_by_name[name], **merged}
                    relays_updated += 1
                else:
                    cur_by_name[name] = merged
                    relays_added += 1
            new_relays = list(cur_by_name.values())
            config[k] = json.dumps(new_relays, ensure_ascii=False)
            keys_touched += 1
        elif (k.endswith("_api_key") or "secret" in k.lower()) and isinstance(v, str) and _looks_masked(v):
            # Skip masked top-level secrets — preserve existing real value.
            continue
        else:
            config[k] = v
            keys_touched += 1

    _write_config(config)
    try:
        from sidecar.engines.oss_sync import invalidate_storage_cache
        invalidate_storage_cache()
    except ImportError:
        pass
    try:
        from sidecar.scheduler.cloud_sync_worker import enqueue_config_replace
        await enqueue_config_replace()
    except Exception:
        pass
    return {
        "ok": True,
        "mode": body.mode,
        "relays_added": relays_added,
        "relays_updated": relays_updated,
        "keys_touched": keys_touched,
    }
