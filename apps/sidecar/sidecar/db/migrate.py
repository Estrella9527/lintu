from sidecar.db.session import engine


async def init_db():
    """Create all tables. Safe to call multiple times."""
    from sidecar.db.models import Base  # noqa: F401 — ensure models are registered

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
