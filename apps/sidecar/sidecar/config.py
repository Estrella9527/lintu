from pathlib import Path
import os

SIDECAR_PORT = int(os.environ.get("LINTU_PORT", "7879"))

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
