from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sidecar.config import DB_URL

engine = create_async_engine(DB_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    """FastAPI dependency: yields an async DB session."""
    async with async_session() as session:
        yield session
