from pathlib import Path
import os

SIDECAR_PORT = int(os.environ.get("LINTU_PORT", "7879"))

# Deployment mode (Phase 2):
#   electron — packaged with the desktop app (default)
#   server   — public-facing Open API; /api/* admin routes are disabled
LINTU_MODE = os.environ.get("LINTU_MODE", "electron").lower()
assert LINTU_MODE in ("electron", "server"), f"LINTU_MODE must be electron or server, got {LINTU_MODE!r}"

# CORS allowlist for server mode. Comma-separated origins; empty = none allowed.
LINTU_ALLOW_CORS = [o.strip() for o in os.environ.get("LINTU_ALLOW_CORS", "").split(",") if o.strip()]

# 数据目录：默认 ~/lintu-data
DATA_DIR = Path(os.environ.get("LINTU_DATA_DIR", Path.home() / "lintu-data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "lintu.db"
# DB connection — defaults to local SQLite for desktop/electron mode.
# Cloud (LINTU_MODE=server) MUST override with LINTU_DB_URL pointing at a
# PostgreSQL instance, e.g.
#   LINTU_DB_URL=postgresql+asyncpg://user:pass@rds-host:5432/lintu
# Why PG in server mode:
#   - SQLite can't handle concurrent UGC traffic (~100ms write lock)
#   - Cross-modal vector search benefits from pgvector's HNSW index
#   - We can run multiple gunicorn workers safely
DB_URL = os.environ.get("LINTU_DB_URL") or f"sqlite+aiosqlite:///{DB_PATH}"
DB_DIALECT = "postgresql" if DB_URL.startswith("postgresql") else "sqlite"

# Server-mode-only: token shared between local sync_worker and the cloud
# sidecar's /internal/sync/* endpoints. NOT a public ApiKey — never
# exposed to UGC. Set on both ends; cloud rejects writes if missing.
LINTU_INTERNAL_SYNC_TOKEN = os.environ.get("LINTU_INTERNAL_SYNC_TOKEN", "").strip()
# Where the local sync_worker pushes to. Empty = sync disabled (electron-only).
LINTU_CLOUD_SYNC_URL = os.environ.get("LINTU_CLOUD_SYNC_URL", "").strip()
# 多设备同步(方案A)拉取开关。默认关:主控桌面端只 push。副设备 / 多端共享同
# 一账号数据时设 LINTU_CLOUD_PULL=1,开启 cloud_pull_worker 从云端拉变更并合并。
# 复用 LINTU_CLOUD_SYNC_URL + LINTU_INTERNAL_SYNC_TOKEN 作为目标与鉴权。
LINTU_CLOUD_PULL = os.environ.get("LINTU_CLOUD_PULL", "").strip() in ("1", "true", "True", "yes")

# 工作空间子目录
WORKSPACE_DIR = DATA_DIR / "workspace"
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

THUMBNAILS_DIR = WORKSPACE_DIR / "thumbnails"
THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)

# Lossless derivatives of originals (rotated, etc.). Originals in Image.file_path
# are NEVER rewritten — any transform that changes pixels writes here and the
# new path is stored in Image.rotated_file_path.
DERIVED_DIR = WORKSPACE_DIR / "derived"
DERIVED_DIR.mkdir(parents=True, exist_ok=True)
