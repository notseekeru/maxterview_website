import os

os.environ["APP_ENV"] = "test"
os.environ["CLERK_ENABLED"] = "false"
os.environ["CLERK_DOMAIN"] = "https://test.clerk.accounts"
os.environ["CLERK_JWKS_URL"] = ""
os.environ["LLM_BASE_URL"] = ""
os.environ["LLM_MODEL"] = ""
os.environ["LLM_API_KEY"] = ""
os.environ.setdefault("DATABASE_URL", "postgresql://x:x@localhost:5432/x")
os.environ["RATE_LIMIT"] = "off"

import atexit

_BASE_DSN = os.environ.get("DATABASE_URL", "")
_TEST_DB = f"maxterview_test_{os.getpid()}"


def _test_db_admin(base: str, create: bool = False) -> bool:
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
                cur.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
                    (_TEST_DB,),
                )
                cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(_TEST_DB)))
        return True
    finally:
        conn.close()


if _BASE_DSN and not os.environ.get("M5_TEST_DATABASE_URL") and _test_db_admin(_BASE_DSN, create=True):
    _throwaway = f"{_BASE_DSN.rsplit('/', 1)[0]}/{_TEST_DB}"
    os.environ["M5_TEST_DATABASE_URL"] = os.environ["DATABASE_URL"] = _throwaway
    atexit.register(_test_db_admin, _BASE_DSN)
