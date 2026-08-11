# Force test values (override any empty/loaded value from the host .env).
import os

os.environ["APP_ENV"] = "test"
os.environ["CLERK_ENABLED"] = "false"
os.environ["CLERK_DOMAIN"] = "https://test.clerk.accounts"
os.environ["CLERK_JWKS_URL"] = ""
os.environ.setdefault("DATABASE_URL", "postgresql://x:x@localhost:5432/x")
