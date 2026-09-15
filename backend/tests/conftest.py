# Force test values (override any empty/loaded value from the host .env).
import os

os.environ["APP_ENV"] = "test"
os.environ["CLERK_ENABLED"] = "false"
os.environ["CLERK_DOMAIN"] = "https://test.clerk.accounts"
os.environ["CLERK_JWKS_URL"] = ""
# llm.py reads env at import: override the dev .env so LLM tests never hit the network.
os.environ["LLM_BASE_URL"] = ""
os.environ["LLM_MODEL"] = ""
os.environ["LLM_API_KEY"] = ""
os.environ.setdefault("DATABASE_URL", "postgresql://x:x@localhost:5432/x")
# The app-level limiter has its own test; the suite must not trip it mid-run (it is keyed per
# client and the whole suite shares one TestClient key).
os.environ["RATE_LIMIT"] = "off"

# --- per-run test database ---------------------------------------------------
# One fixed identity (`CLERK_ENABLED=false` -> DEV_USER) plus per-(owner, UTC day) turn counters means
# a second run inside the same UTC day inherits the first run's spend: quota-gated endpoints start
# answering 402 and unrelated tests fail. So each run gets its own database (migrated by
# `test_api.migrated_db`). A per-job CI Postgres, or anyone wanting to inspect the data afterwards,
# opts out by naming one: `M5_TEST_DATABASE_URL=… pytest`.
import atexit

_BASE_DSN = os.environ.get("DATABASE_URL", "")
_TEST_DB = f"maxterview_test_{os.getpid()}"


def _test_db_admin(base: str, create: bool = False) -> bool:
    """Best-effort CREATE/DROP of this run's own database. False when no server is reachable."""
    try:
        import psycopg2
        from psycopg2 import sql

        conn = psycopg2.connect(base)
    except Exception:
        return False  # unit-only run, or a placeholder DSN: leave the caller's default alone
    try:
        conn.autocommit = True  # both statements are non-transactional
        with conn.cursor() as cur:
            if create:
                cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(_TEST_DB)))
                cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(_TEST_DB)))
            else:
                # Any pool left open by a failed test would block the drop; kill it first.
                cur.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
                    (_TEST_DB,),
                )
                cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(_TEST_DB)))
        return True
    finally:
        conn.close()


# Guarded on the env var the integration tests already honour, so an explicit DSN always wins.
if _BASE_DSN and not os.environ.get("M5_TEST_DATABASE_URL") and _test_db_admin(_BASE_DSN, create=True):
    _throwaway = f"{_BASE_DSN.rsplit('/', 1)[0]}/{_TEST_DB}"
    os.environ["M5_TEST_DATABASE_URL"] = os.environ["DATABASE_URL"] = _throwaway
    # A leftover `maxterview_test_*` database is harmless, so cleanup never fails a green run.
    atexit.register(_test_db_admin, _BASE_DSN)
