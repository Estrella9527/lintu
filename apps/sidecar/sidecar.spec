# PyInstaller spec for the lintu Python sidecar.
#
# Build with:  uv run pyinstaller sidecar.spec --noconfirm --clean
# Output:      apps/sidecar/dist/sidecar/  (a folder with sidecar.exe + _internal/)
#
# Why a spec file (not flags): we have enough hidden imports + data files that
# putting it all on a CLI is unreadable and easy to break across machines.
# A spec is a checked-in source-of-truth.

# ruff: noqa
# pyright: ignore

from PyInstaller.utils.hooks import collect_all, collect_submodules
from pathlib import Path

block_cipher = None
PROJECT_ROOT = Path(SPECPATH).resolve()  # apps/sidecar/

# ── Data files ───────────────────────────────────────────────────────────────
# Alembic needs its config and the migrations folder at runtime. We place
# both at the bundle root so `Path(sys._MEIPASS) / "alembic.ini"` resolves
# (see sidecar/db/migrate.py).
datas = [
    (str(PROJECT_ROOT / "alembic.ini"), "."),
    (str(PROJECT_ROOT / "alembic"), "alembic"),
]
binaries = []
hiddenimports = []

# Top-level packages that need full data + submodule collection.
# uvicorn/fastapi/sqlalchemy/alembic all use dynamic imports that PyInstaller
# can't see statically. collect_all pulls in their submodules + data files.
COLLECT_PACKAGES = [
    "uvicorn",
    "fastapi",
    "starlette",
    "pydantic",
    "sqlalchemy",
    "alembic",
    "asyncpg",
    "psycopg",
    "aiosqlite",
    "anyio",
    "h11",
    "httptools",
    "httpx",
    "wsproto",
    "websockets",
    "jieba",          # has dict.txt + idf.txt data files
    "imagehash",
    "PIL",            # Pillow — many image format plugins
    "fitz",           # pymupdf
    "openpyxl",
    "docx",           # python-docx
    "oss2",
    "google.generativeai",
    "numpy",
    "scipy",          # quality_check.py uses scipy.signal.convolve2d
    "multipart",      # python-multipart
    # Aliyun SMS SDK (手机号登录验证码) — sms_aliyun.py imports these lazily;
    # missing them in the bundle causes a silent ImportError fallback where
    # the code is logged to stdout but no SMS goes out.
    "alibabacloud_dysmsapi20170525",
    "alibabacloud_tea_openapi",
    "alibabacloud_tea_util",
    "alibabacloud_credentials",
    "alibabacloud_credentials_api",
    "alibabacloud_gateway_spi",
    "Tea",            # alibabacloud-tea (PyPI) installs as top-level Tea/
    "darabonba",      # darabonba-core, transitive runtime dep of tea-openapi
]

for pkg in COLLECT_PACKAGES:
    try:
        d, b, h = collect_all(pkg)
        datas.extend(d)
        binaries.extend(b)
        hiddenimports.extend(h)
    except Exception as e:
        print(f"[spec] collect_all({pkg!r}) skipped: {e}")

# Belt-and-suspenders for the alibabacloud SDK family — collect_all() has been
# observed (Windows v0.2.4) to skip dysmsapi / tea_openapi / gateway_spi /
# credentials_api submodules entirely, which makes `from alibabacloud_dysmsapi
# 20170525.client import Client` fail at runtime even though the package is
# present in the bundle. Force every submodule into hiddenimports so the
# static analyzer can't miss any of them.
for pkg in (
    "alibabacloud_dysmsapi20170525",
    "alibabacloud_tea_openapi",
    "alibabacloud_tea_util",
    "alibabacloud_credentials",
    "alibabacloud_credentials_api",
    "alibabacloud_gateway_spi",
    "Tea",
    "darabonba",
):
    try:
        hiddenimports.extend(collect_submodules(pkg))
    except Exception as e:
        print(f"[spec] collect_submodules({pkg!r}) skipped: {e}")

# Extra hidden imports for uvicorn's lazy protocol/loop loading.
# These won't appear via collect_submodules because they're imported
# behind try/except guards.
hiddenimports.extend([
    "uvicorn.lifespan.on",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.logging",
    "sqlalchemy.dialects.sqlite",
    "sqlalchemy.dialects.postgresql",
    "sqlalchemy.dialects.postgresql.asyncpg",
    "sqlalchemy.dialects.postgresql.psycopg",
])

# All sidecar submodules — main.py imports many routers/engines via static
# `from sidecar.routers import (a, b, c, ...)` lines, which PyInstaller catches
# fine, but engines/strategies are imported lazily inside lifespan handlers
# (see sidecar/main.py lifespan). collect_submodules guarantees nothing is
# missed even if someone adds a new lazy import later.
hiddenimports.extend(collect_submodules("sidecar"))

# Dedupe
hiddenimports = sorted(set(hiddenimports))

# ── Excludes ─────────────────────────────────────────────────────────────────
# Drop the local-CLIP optional stack (torch + open_clip + scipy + CUDA wheels
# = ~1.5 GB) — this build targets cloud-API embedding only. If you ever want
# local CLIP in the desktop build, comment these out and `uv sync --extra
# local-clip` before running PyInstaller.
excludes = [
    # local-CLIP optional stack — see pyproject.toml [local-clip] extra.
    # scipy is NOT excluded: sidecar/engines/quality_check.py imports
    # `scipy.signal.convolve2d` unconditionally for blur detection. Excluding
    # scipy causes a silent import failure during uvicorn lifespan startup.
    "torch",
    "torchvision",
    "torchaudio",
    "open_clip",
    "open_clip_torch",
    # dev-only deps that may slip in via transitive resolution
    "pytest",
    "ipython",
    "jupyter",
    "notebook",
    "tkinter",
    "matplotlib",
]

# ── Analysis / EXE / COLLECT ─────────────────────────────────────────────────
a = Analysis(
    [str(PROJECT_ROOT / "launcher.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,            # UPX often false-positives in AV scanners on Windows
    console=True,         # keep console for now — easier to grab logs
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="sidecar",
)
