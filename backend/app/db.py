import os

import asyncpg

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is required")

_pool: asyncpg.Pool | None = None


async def init_pool() -> None:
    global _pool
    if _pool is None:
        # min_size=0 keeps the pool lazy so /health works even when Postgres is down (CD smoke).
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=0, max_size=10)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("pool not initialized; call init_pool() during app startup")
    return _pool


async def fetch(query: str, *args) -> list[asyncpg.Record]:
    return await get_pool().fetch(query, *args)


async def fetchrow(query: str, *args) -> asyncpg.Record | None:
    return await get_pool().fetchrow(query, *args)


async def execute(query: str, *args) -> str:
    return await get_pool().execute(query, *args)
