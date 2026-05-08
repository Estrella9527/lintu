"""Shared pytest fixtures for the sidecar test suite.

Critical: env vars (`LINTU_DATA_DIR` and friends) must be set BEFORE the
sidecar package gets imported, since `sidecar.config` reads them at module
import time and creates DATA_DIR with side-effects (mkdir).

To make this safe regardless of pytest collection order, we set the env vars
at module top — pytest imports conftest.py first thing, before any test
module that pulls in sidecar.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# ── Step 1: env-var setup (BEFORE any sidecar import) ────────────────────
# Use a per-session tmpdir so parallel pytest workers don't share state.
_TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="lintu-test-"))
os.environ["LINTU_DATA_DIR"] = str(_TEST_DATA_DIR)
os.environ["LINTU_MODE"] = "electron"           # leaves /api/* mounted, no auth
os.environ["LINTU_DB_URL"] = f"sqlite+aiosqlite:///{_TEST_DATA_DIR}/lintu.db"
# 跳过用户系统鉴权 — 测试默认走 SYSTEM_ROOT 身份。
# 单独的 test_auth.py / test_tenant_isolation.py 会临时清除这个 env 走真实流。
os.environ["LINTU_AUTH_BYPASS"] = "1"
# Disable cloud sync entirely so test mutations don't fan out to imaginary URLs.
os.environ.pop("LINTU_CLOUD_SYNC_URL", None)
os.environ.pop("LINTU_INTERNAL_SYNC_TOKEN", None)

# Ensure the package is importable regardless of where pytest is invoked from.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


# ── Step 2: actual fixtures (sidecar is safe to import below this line) ──
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient


@pytest.fixture(scope="session")
def test_data_dir() -> Path:
    """Tmp dir holding the test SQLite DB + workspace. Same for whole session."""
    return _TEST_DATA_DIR


@pytest.fixture(scope="session")
def app():
    """Boot the FastAPI app once per session. lifespan creates schema via
    `init_db()` (alembic upgrade head against the tmp SQLite)."""
    # Importing here (not at module top) keeps the env vars above effective.
    from sidecar.main import app as fastapi_app
    return fastapi_app


@pytest.fixture(scope="session")
def client(app):
    """FastAPI TestClient. The `with` block triggers lifespan startup +
    shutdown so init_db() actually runs."""
    with TestClient(app) as c:
        yield c


@pytest_asyncio.fixture
async def db_session():
    """Per-test async session — caller can read/write the test DB directly
    when assertions need to inspect state past the API surface."""
    from sidecar.db.session import async_session
    async with async_session() as s:
        yield s


@pytest_asyncio.fixture
async def sample_project(db_session):
    """Create a throwaway project + return its id. Useful for endpoints that
    require project_id. Cleaned up indirectly when the test data dir gets
    nuked at session end."""
    from sidecar.db.models import Project
    proj = Project(
        name=f"test-{os.urandom(3).hex()}",
        originals_path=str(_TEST_DATA_DIR / "imgs"),
        workspace_path=str(_TEST_DATA_DIR / "ws"),
    )
    db_session.add(proj)
    await db_session.commit()
    await db_session.refresh(proj)
    return proj.id
