# Force test values (override any empty/loaded value from the host .env).
import os

os.environ["APP_ENV"] = "test"
os.environ["CLERK_ENABLED"] = "false"
os.environ["CLERK_DOMAIN"] = "https://test.clerk.accounts"
os.environ["CLERK_JWKS_URL"] = ""
# Force LLM STUB_MODE for tests (llm.py reads env at import): the dev .env may set a real
# LLM_BASE_URL, which would make LLM tests hit the network. Tests must run model-free.
os.environ["LLM_BASE_URL"] = ""
os.environ["LLM_MODEL"] = ""
os.environ["LLM_API_KEY"] = ""
os.environ.setdefault("DATABASE_URL", "postgresql://x:x@localhost:5432/x")
