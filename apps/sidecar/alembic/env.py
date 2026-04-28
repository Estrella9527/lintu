"""Alembic environment for lintu-sidecar.

Uses the sync SQLite engine for DDL (Alembic's migration DSL is synchronous).
The application itself continues to use the async engine at runtime.
"""
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from sidecar.config import DB_PATH
from sidecar.db.models import Base

config = context.config

sync_url = f"sqlite:///{DB_PATH}"
config.set_main_option("sqlalchemy.url", sync_url)

if config.config_file_name is not None:
    try:
        fileConfig(config.config_file_name)
    except Exception:
        pass

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=sync_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(sync_url, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
