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
DB_URL = f"sqlite+aiosqlite:///{DB_PATH}"

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
