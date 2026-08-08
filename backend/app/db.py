# db.py — single extraction for the async engine/session (mirrors db.ts).
# DATABASE_URL is never in .env (D5); compose overlays / prod Secret inject it.
import os

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is required")

# pool_pre_ping guards against stale pooled connections after a DB restart.
engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
