"""Database migrations driven by Alembic.

At startup we call `init_db()`, which:
  1. If the DB file has tables but no `alembic_version`, stamps it at baseline
     (handles adoption of existing pre-Alembic installations).
  2. Runs `alembic upgrade head` to apply any pending migrations.

Alembic commands are sync; we wrap them in `asyncio.to_thread` so the lifespan
coroutine doesn't block the event loop.
"""
import asyncio
import logging
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from sidecar.config import DB_PATH

logger = logging.getLogger(__name__)

SIDECAR_ROOT = Path(__file__).resolve().parents[2]  # apps/sidecar/
ALEMBIC_INI = SIDECAR_ROOT / "alembic.ini"
ALEMBIC_DIR = SIDECAR_ROOT / "alembic"

BASELINE_REVISION = "20260421_0000"
BASELINE_TABLES = {"projects", "images", "tags", "tasks", "prompts", "strategies", "duplicate_groups"}


def _alembic_cfg() -> Config:
    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("script_location", str(ALEMBIC_DIR))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{DB_PATH}")
    return cfg


def _adopt_existing_db_if_needed() -> None:
    """If DB has the full baseline schema but no alembic_version, stamp it.

    Adoption only fires when every baseline table is present. A partial DB
    (missing some baseline tables) is left alone so the failure surface is
    obvious — dropping the legacy DB and re-initializing is safer than
    silently patching a half-migrated schema.
    """
    if not Path(DB_PATH).exists():
        return
    sync_engine = create_engine(f"sqlite:///{DB_PATH}")
    try:
        insp = inspect(sync_engine)
        tables = set(insp.get_table_names())
        if "alembic_version" in tables:
            return
        if not BASELINE_TABLES.issubset(tables):
            return
        logger.info("Adopting existing DB: stamping baseline %s", BASELINE_REVISION)
        command.stamp(_alembic_cfg(), BASELINE_REVISION)
    finally:
        sync_engine.dispose()


def _run_migrations() -> None:
    _adopt_existing_db_if_needed()
    command.upgrade(_alembic_cfg(), "head")
    logger.info("Alembic upgrade complete")


async def init_db():
    await asyncio.to_thread(_run_migrations)
