"""Alembic environment for lintu-sidecar.

Uses the sync engine for DDL (Alembic's migration DSL is synchronous). The
application itself uses the async engine at runtime.

DB selection priority:
  1. LINTU_DB_URL env var (cloud / server mode → PostgreSQL)
  2. DB_PATH from config.py (local / electron mode → SQLite)
"""
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from sidecar.config import DB_PATH
from sidecar.db.models import Base

config = context.config

# Read LINTU_DB_URL first (set by cloud sidecar), fall back to local SQLite.
# We strip the asyncpg / aiosqlite suffix because Alembic uses sync drivers.
_async_url = os.environ.get("LINTU_DB_URL", "").strip()
if _async_url:
    sync_url = (
        _async_url
        .replace("postgresql+asyncpg://", "postgresql+psycopg://", 1)
        .replace("sqlite+aiosqlite://", "sqlite://", 1)
    )
else:
    sync_url = f"sqlite:///{DB_PATH}"

config.set_main_option("sqlalchemy.url", sync_url)

if config.config_file_name is not None:
    try:
        fileConfig(config.config_file_name)
    except Exception:
        pass

target_metadata = Base.metadata

# render_as_batch is needed for SQLite ALTER TABLE limitations; on PG it's
# harmless but unnecessary, so disable it to keep migrations cleaner.
_render_as_batch = sync_url.startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(
        url=sync_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=_render_as_batch,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(sync_url, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=_render_as_batch,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
