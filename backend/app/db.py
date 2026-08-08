# db.py — asyncpg pool (raw SQL, mirrors diagram_website's pg pool).
# DATABASE_URL is never in .env (D5); compose overlays / prod inject it.
# The pool is created lazily via init_pool() so the CD smoke container
# (dummy DATABASE_URL, no Postgres) can still boot and serve /health.
import os

import asyncpg

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is required")

_pool: asyncpg.Pool | None = None


async def init_pool() -> None:
    """Create the asyncpg pool. Idempotent; call once in lifespan startup."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10)


async def close_pool() -> None:
    """Close the pool. Call once in lifespan shutdown."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    """Return the initialized pool, or raise if init_pool() hasn't run yet."""
    if _pool is None:
        raise RuntimeError("pool not initialized; call init_pool() during app startup")
    return _pool


async def fetch(query: str, *args) -> list[asyncpg.Record]:
    """Run a SELECT and return all rows. Raw SQL, positional args ($1, $2...)."""
    return await get_pool().fetch(query, *args)


async def fetchrow(query: str, *args) -> asyncpg.Record | None:
    """Run a SELECT and return the first row or None."""
    return await get_pool().fetchrow(query, *args)


async def execute(query: str, *args) -> str:
    """Run a write/DDL statement (INSERT/UPDATE/DELETE)."""
    return await get_pool().execute(query, *args)
