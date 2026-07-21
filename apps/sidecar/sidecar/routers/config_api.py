import json
import logging
import os
import platform
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.config import DATA_DIR
from sidecar.time_utils import utc_iso

router = APIRouter()
logger = logging.getLogger(__name__)

CONFIG_FILE = DATA_DIR / "config.json"

# Config 写入版本号，用于检测「另一台机器在我这次保存前刚改过」。每次写
# 入自增 1。不入审计日志（审计自带 created_at）。
_VERSION_KEY = "__version"


def _get_version(config: dict) -> int:
    v = config.get(_VERSION_KEY)
    return int(v) if isinstance(v, (int, float)) else 0


def _bump_version(config: dict) -> int:
    nv = _get_version(config) + 1
    config[_VERSION_KEY] = nv
    return nv


# ── Audit helpers ──────────────────────────────────────────────────────────
# 每次 PUT /api/config 把 diff 写到 config_audit_logs，让线上 last-write-wins
# 的"谁覆盖了谁"可以追溯。
async def _write_audit(
    diff: dict[str, tuple],
    *,
    source: str = "desktop",
) -> None:
    """diff = { key: (old, new) }；old / new 都允许 None（首次写 / 删除）。"""
    if not diff:
        return
    try:
        from sidecar.db.models import ConfigAuditLog
        from sidecar.db.session import async_session
        meta = {
            "host": platform.node(),
            "pid":  os.getpid(),
        }
        async with async_session() as db:
            for key, (old, new) in diff.items():
                db.add(ConfigAuditLog(
                    key=key,
                    old_value=old,
                    new_value=new,
                    source=source,
                    actor_meta=meta,
                ))
            await db.commit()
    except Exception as e:
        # 审计失败绝不能阻塞配置保存 — 只 log，不抛
        logger.warning("config audit write failed: %s", e)


def _diff_config(old: dict, incoming: dict) -> dict[str, tuple]:
    out: dict[str, tuple] = {}
    for k, v_new in incoming.items():
        v_old = old.get(k)
        if v_old != v_new:
            out[k] = (v_old, v_new)
    return out


def _read_config() -> dict:
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text())
    return {}


def _write_config(data: dict):
    CONFIG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


class UpdateConfigBody(BaseModel):
    data: dict
    # 乐观锁：客户端打 PUT 前看到的版本号。服务端当前版本不等于这个 →
    # 409 conflict + 当前 snapshot，让前端弹"另一台机器刚改过，是否覆盖？"
    # 不传（None）= 旧客户端 / 不关心冲突 → 跳过检查，原行为不变。
    if_version: int | None = None


@router.get("")
async def get_config():
    config = _read_config()
    # Mask sensitive keys (only mask string values that look like secrets)
    safe = {}
    for k, v in config.items():
        if k == _VERSION_KEY:
            continue   # 单独走 __version 字段下发，不混在普通 config 里
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
    safe[_VERSION_KEY] = _get_version(config)
    return safe


def _looks_masked(value: str) -> bool:
    return isinstance(value, str) and "****" in value


@router.put("")
async def update_config(body: UpdateConfigBody):
    config = _read_config()
    incoming = dict(body.data)

    # 乐观锁检查：客户端如果传了 if_version，服务端当前版本不一致 → 409。
    # body 不带 if_version（旧客户端 / 不关心冲突的 caller）→ 跳过检查。
    if body.if_version is not None:
        cur_v = _get_version(config)
        if body.if_version != cur_v:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "version_conflict",
                    "message": f"配置已被另一处修改：你看到的版本 {body.if_version}，服务端当前 {cur_v}",
                    "expected_version": body.if_version,
                    "current_version": cur_v,
                },
            )

    # 不让 caller 通过 data 直接写 __version 字段绕过版本号
    incoming.pop(_VERSION_KEY, None)

    # Preserve existing secrets when caller sent the masked placeholder back.
    # The GET endpoint masks api_key / *_key / *_secret values; if the UI
    # round-trips them unchanged, we must NOT overwrite the real value.
    for k, v in list(incoming.items()):
        if k == "custom_relays" and isinstance(v, str):
            try:
                new_relays = json.loads(v)
                old_relays = json.loads(config.get("custom_relays", "[]"))
                old_by_name = {r.get("name"): r for r in old_relays if r.get("name")}
                for index, r in enumerate(new_relays):
                    key = r.get("api_key", "")
                    if _looks_masked(key):
                        prev = old_by_name.get(r.get("name"))
                        # Editing a relay can rename it while the UI still
                        # carries the masked key. Name lookup then misses;
                        # preserve the secret from the same stable list slot
                        # rather than writing "xxxx****" as the real token.
                        if not prev and index < len(old_relays):
                            prev = old_relays[index]
                        if prev and prev.get("api_key"):
                            r["api_key"] = prev["api_key"]
                incoming[k] = json.dumps(new_relays, ensure_ascii=False)
            except (json.JSONDecodeError, TypeError):
                pass
        elif ("key" in k.lower() or "secret" in k.lower()) and _looks_masked(v):
            if k in config:
                incoming[k] = config[k]

    # 在 update 之前 diff，避免 update 后 old==new 没差异。
    diff = _diff_config(config, incoming)

    config.update(incoming)
    new_version = _bump_version(config)
    _write_config(config)

    # 审计：异步写不阻塞主路径，失败不影响保存
    if diff:
        await _write_audit(diff, source="desktop")

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
    return {"ok": True, "__version": new_version}


# ── Recently-shown cooldown (per project) admin endpoints ───────────────────


class OSSTestBody(BaseModel):
    """Pre-save credential check for the OSS settings tab. Sends ephemeral
    creds, runs a minimal HEAD against the bucket. If `endpoint`+`bucket` are
    set without `access_key`+`access_secret`, falls back to a public-URL
    check using the configured `cdn_base` (read-only deployments)."""
    oss_provider: str
    oss_endpoint: str
    oss_bucket: str
    oss_access_key: str | None = None
    oss_access_secret: str | None = None
    oss_cdn_base: str | None = None


@router.post("/oss/test")
async def test_oss(body: OSSTestBody):
    """Validate OSS credentials and reachability without persisting them.

    Returns:
      { ok: true, mode: 'read_write' | 'read_only', message: '...' }
    or { ok: false, code: 'auth_error' | 'not_found' | 'network' | ..., message: '...' }
    """
    if (body.oss_provider or "").lower() != "aliyun":
        return {"ok": False, "code": "unsupported", "message": f"暂不支持 provider={body.oss_provider}"}
    if not body.oss_endpoint or not body.oss_bucket:
        return {"ok": False, "code": "missing_fields", "message": "endpoint 和 bucket 必填"}

    # Path A: have write creds → try a HEAD against the bucket.
    # `bucket.get_bucket_info()` is the canonical "are we authenticated and
    # is the bucket reachable" round-trip on Aliyun OSS — minimal, idempotent.
    if body.oss_access_key and body.oss_access_secret and not _looks_masked(body.oss_access_secret):
        try:
            import oss2  # lazy: only loaded when test button pressed
            endpoint = body.oss_endpoint
            if not endpoint.startswith("http"):
                endpoint = "https://" + endpoint
            auth = oss2.Auth(body.oss_access_key, body.oss_access_secret)
            bucket = oss2.Bucket(auth, endpoint, body.oss_bucket, connect_timeout=5)
            info = bucket.get_bucket_info()
            return {
                "ok": True,
                "mode": "read_write",
                "message": f"连接成功（bucket location: {info.location}）",
            }
        except Exception as e:
            msg = str(e)
            code = "network"
            if "AccessDenied" in msg or "InvalidAccessKey" in msg or "SignatureDoesNotMatch" in msg:
                code = "auth_error"
            elif "NoSuchBucket" in msg:
                code = "not_found"
            return {"ok": False, "code": code, "message": msg[:200]}

    # Path B: no write creds → only verify CDN base reachability for read-only
    # cloud sidecar setups.
    if body.oss_cdn_base:
        try:
            import httpx
            base = body.oss_cdn_base.rstrip("/")
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.head(base)
            # Any HTTP response (including 403/404) means DNS + TCP work — that's
            # the meaningful signal here. Only network errors are real failures.
            return {
                "ok": True,
                "mode": "read_only",
                "message": f"CDN base 可达（HTTP {r.status_code}）",
            }
        except Exception as e:
            return {"ok": False, "code": "network", "message": f"CDN base 不可达：{e}"}

    return {"ok": False, "code": "missing_fields", "message": "需要 access_key+secret 或 cdn_base 之一"}


@router.get("/audit-log")
async def list_config_audit(
    key: str | None = Query(None, description="只看某个 config key 的历史"),
    limit: int = Query(50, ge=1, le=500),
):
    """近期 config 变更记录，最新在前。
    用于「谁动了我的匹配策略」类追溯。
    """
    from sidecar.db.models import ConfigAuditLog
    from sidecar.db.session import async_session
    async with async_session() as db:
        q = select(ConfigAuditLog).order_by(desc(ConfigAuditLog.created_at)).limit(limit)
        if key:
            q = q.where(ConfigAuditLog.key == key)
        rows = (await db.execute(q)).scalars().all()
    return [
        {
            "id": r.id,
            "key": r.key,
            "old_value": r.old_value,
            "new_value": r.new_value,
            "source": r.source,
            "actor_meta": r.actor_meta,
            "created_at": utc_iso(r.created_at),
        }
        for r in rows
    ]


@router.get("/sync-status")
async def get_cloud_sync_status():
    """暴露 cloud sync 是否启用 + 推送目标，让 UI 在「匹配策略」之类的页面
    上方明确告诉操作者：「保存会影响线上 UGC」 vs 「只本地生效」。

    返回字段：
      - enabled        bool — 当前 sidecar 进程是否会同步出去
      - target_url     str | null — 目标云端地址（启用时；用于显示给操作者）
      - has_token      bool — 是否同时配了 internal sync token（少了也算未启用）
      - pending_jobs   int  — 当前 cloud_sync_jobs 里 pending 的行数（队列积压）
    """
    from sidecar.config import LINTU_CLOUD_SYNC_URL, LINTU_INTERNAL_SYNC_TOKEN
    enabled = bool(LINTU_CLOUD_SYNC_URL and LINTU_INTERNAL_SYNC_TOKEN)

    pending = 0
    if enabled:
        try:
            from sqlalchemy import func, select
            from sidecar.db.models import CloudSyncJob
            from sidecar.db.session import async_session
            async with async_session() as db:
                pending = int(await db.scalar(
                    select(func.count())
                    .select_from(CloudSyncJob)
                    .where(CloudSyncJob.status == "pending")
                ) or 0)
        except Exception:
            pending = 0

    # 目标 URL 直接展示给操作者（不脱敏）— 这本身不是凭据，只是 endpoint，
    # 让运营能看出"我推到的是哪个环境"。
    return {
        "enabled": enabled,
        "target_url": LINTU_CLOUD_SYNC_URL or None,
        "has_token": bool(LINTU_INTERNAL_SYNC_TOKEN),
        "pending_jobs": pending,
    }


@router.post("/match-cooldown/reset")
async def reset_match_cooldown(project_id: str | None = None):
    """Clear the server-side recent-shown cooldown buffer.
    Pass ?project_id=... to scope to one project; omit to wipe all.
    Useful after content changes or when debugging match results."""
    from sidecar.engines import recent_shown
    n = recent_shown.reset(project_id)
    return {"ok": True, "cleared": n, "project_id": project_id}


@router.get("/cloud-pull-status")
async def get_cloud_pull_status():
    """设置页「多设备同步」状态:开关 + 上次同步时间/计数。"""
    from sidecar.scheduler.cloud_pull_worker import pull_status
    return pull_status()


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
