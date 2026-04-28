"""Dump the FastAPI OpenAPI schema to docs/openapi.json.

Run from repo root:

    cd apps/sidecar && uv run python scripts/export_openapi.py

Forces LINTU_MODE=server before importing main so /docs and /openapi.json
are mounted and external endpoints are reflected.
"""
import json
import os
import sys
from pathlib import Path

# IMPORTANT: must set BEFORE importing sidecar.main
os.environ.setdefault("LINTU_MODE", "server")

# Make `sidecar.*` importable when running from apps/sidecar/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sidecar.main import app  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent  # /apps/sidecar/scripts → /
OUT_PATH = REPO_ROOT / "docs" / "openapi.json"


def main() -> None:
    schema = app.openapi()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(schema, indent=2, ensure_ascii=False))
    print(f"wrote {OUT_PATH} ({len(json.dumps(schema))} bytes, {len(schema.get('paths', {}))} paths)")


if __name__ == "__main__":
    main()
