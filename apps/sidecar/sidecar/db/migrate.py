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
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from sidecar.config import DB_PATH

logger = logging.getLogger(__name__)

# When running from a PyInstaller --onedir bundle, alembic data is unpacked
# alongside the modules under sys._MEIPASS. Outside the bundle (`uv run`),
# fall back to the source-tree layout.
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    SIDECAR_ROOT = Path(sys._MEIPASS)
else:
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


def _has_pending_migrations() -> bool:
    """当前库版本是否落后于 head(决定要不要做迁移前备份)。"""
    if not Path(DB_PATH).exists():
        return False
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory
    try:
        cfg = _alembic_cfg()
        script = ScriptDirectory.from_config(cfg)
        head = script.get_current_head()
        sync_engine = create_engine(f"sqlite:///{DB_PATH}")
        try:
            with sync_engine.connect() as conn:
                current = MigrationContext.configure(conn).get_current_revision()
        finally:
            sync_engine.dispose()
        return current != head
    except Exception as e:
        # 判断不了就当作"可能有",走备份路径更安全
        logger.warning("检测待迁移版本失败,按需备份: %s", e)
        return True


def _run_migrations() -> None:
    from sidecar.db import backup

    _adopt_existing_db_if_needed()

    # 仅在确有待应用迁移时做迁移前备份 —— 没有 pending 时(绝大多数正常启动)
    # 跳过,避免每次开 app 都拷一份库。
    snapshot = None
    if _has_pending_migrations():
        snapshot = backup.backup_before_migration()

    try:
        command.upgrade(_alembic_cfg(), "head")
    except Exception as e:
        logger.error("Alembic 迁移失败: %s", e)
        if snapshot and backup.restore_from(snapshot):
            logger.error("数据库已回滚到迁移前状态。请修复迁移脚本后重试。")
        raise
    logger.info("Alembic upgrade complete")

    # 迁移成功后顺手做一份当日快照(轮转保留最近 7 天)
    try:
        backup.daily_snapshot()
    except Exception as e:
        logger.warning("每日快照失败(不影响启动): %s", e)


async def init_db():
    await asyncio.to_thread(_run_migrations)
