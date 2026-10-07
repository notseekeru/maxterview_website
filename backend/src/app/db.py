import json
import os
import time

import asyncpg

from app import telemetry

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is required")

_pool: asyncpg.Pool | None = None


async def _init_pool_on_connect(conn: asyncpg.Connection) -> None:
    # Without this, JSONB round-trips as a JSON string, not a dict/list
    # (silently breaks scores/tips reads).
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def init_pool() -> None:
    global _pool
    if _pool is None:
        # min_size=0 keeps the pool lazy so /health works even when Postgres is down (CD smoke).
        _pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=0,
            max_size=10,
            # A `-pooler` DSN means PgBouncer (transaction mode), which breaks asyncpg's implicit
            # prepared statements. Off only there; direct hosts keep the cache.
            statement_cache_size=0 if "-pooler" in DATABASE_URL else 10,
            init=_init_pool_on_connect,
        )


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
    return await _query("fetch", query, args)


async def fetchrow(query: str, *args) -> asyncpg.Record | None:
    return await _query("fetchrow", query, args)


# The first keyword only. The label stays bounded by construction, so no query text ever reaches it.
_OPERATIONS = frozenset({"SELECT", "INSERT", "UPDATE", "DELETE", "WITH"})


def _operation(query: str) -> str:
    first = query.lstrip().split(None, 1)[0].upper() if query.strip() else ""
    return first if first in _OPERATIONS else "other"


assert _operation("\n  SELECT 1") == "SELECT" and _operation("EXPLAIN 1") == "other"


async def _query(method: str, query: str, args: tuple):
    """Wait and execution are sampled apart, because a queued connection and a slow query are
    different faults and only one of them is the database's."""
    pool = get_pool()
    queued = time.perf_counter()
    async with pool.acquire() as conn:
        telemetry.record("db.pool.wait.duration", time.perf_counter() - queued)
        running = time.perf_counter()
        result = await getattr(conn, method)(query, *args)
        telemetry.record("db.query.duration", time.perf_counter() - running, **{"db.operation": _operation(query)})
    return result
