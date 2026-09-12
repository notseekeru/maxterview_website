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
