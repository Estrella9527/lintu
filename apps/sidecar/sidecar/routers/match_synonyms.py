"""Persistent synonym dictionary for the keyword-extract step.

The match pipeline normalizes natural-language phrases ("傍晚" → "黄昏",
"小朋友" → "儿童") before jieba tokenization so the keyword recall hits the
canonical tag values. The dictionary used to be hardcoded in
keyword_extract.py; this router lets ops curate it from the UI without
needing to redeploy.

Storage: DATA_DIR/match_synonyms.json — same pattern as tag_schema.json.
On every mutation we bump a version number so the in-process cache in
keyword_extract.py can invalidate without a sidecar restart.
"""
from __future__ import annotations

import json
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from sidecar.config import DATA_DIR

router = APIRouter()

SYNONYMS_FILE = DATA_DIR / "match_synonyms.json"


def _read() -> dict:
    if SYNONYMS_FILE.exists():
        try:
            return json.loads(SYNONYMS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {"version": 0, "entries": {}}
    return {"version": 0, "entries": {}}


def _write(data: dict) -> None:
    data["version"] = int(time.time() * 1000)
    SYNONYMS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SYNONYMS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_runtime_synonyms() -> dict[str, str]:
    """Used by keyword_extract.py — returns plain {alias → canonical} map."""
    data = _read()
    entries = data.get("entries") or {}
    if not isinstance(entries, dict):
        return {}
    return {str(k): str(v) for k, v in entries.items() if k and v}


def get_runtime_version() -> int:
    return int(_read().get("version") or 0)


@router.get("")
async def list_synonyms():
    data = _read()
    return {
        "version": data.get("version") or 0,
        "entries": data.get("entries") or {},
    }


class SynonymBody(BaseModel):
    alias: str
    canonical: str


@router.post("")
async def add_synonym(body: SynonymBody):
    alias = (body.alias or "").strip()
    canonical = (body.canonical or "").strip()
    if not alias or not canonical:
        raise HTTPException(400, "alias and canonical are required")
    if alias == canonical:
        raise HTTPException(400, "alias must differ from canonical")
    data = _read()
    entries = dict(data.get("entries") or {})
    entries[alias] = canonical
    data["entries"] = entries
    _write(data)
    return {"ok": True, "version": data["version"], "entries": entries}


@router.delete("/{alias}")
async def delete_synonym(alias: str):
    data = _read()
    entries = dict(data.get("entries") or {})
    if alias in entries:
        del entries[alias]
        data["entries"] = entries
        _write(data)
    return {"ok": True, "version": data["version"], "entries": entries}
