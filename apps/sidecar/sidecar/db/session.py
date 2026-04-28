from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sidecar.config import DB_URL, DB_DIALECT

# SQLite-specific connect args (timeout, isolation) don't apply to PG, and
# PG's asyncpg driver doesn't accept arbitrary kwargs — only set them when
# we're actually on SQLite.
_engine_kwargs: dict = {"echo": False}
if DB_DIALECT == "sqlite":
    _engine_kwargs["connect_args"] = {"timeout": 30}  # wait up to 30s for lock
else:
    # PG / asyncpg: rely on connection-pool defaults; raise pool size for
    # the cloud sidecar serving UGC concurrency.
    _engine_kwargs["pool_size"] = 10
    _engine_kwargs["max_overflow"] = 10
    _engine_kwargs["pool_pre_ping"] = True

engine = create_async_engine(DB_URL, **_engine_kwargs)


if DB_DIALECT == "sqlite":
    # WAL mode enables concurrent readers + a single writer — required for
    # the desktop app where the React renderer polls heavily while engines
    # write. PG handles its own MVCC, no PRAGMA equivalent needed.
    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    """FastAPI dependency: yields an async DB session."""
    async with async_session() as session:
        yield session
