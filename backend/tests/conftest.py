# Set env before importing app modules (db.py reads DATABASE_URL at import).
import os

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("CLERK_ENABLED", "false")
os.environ.setdefault("DATABASE_URL", "postgresql://x:x@localhost:5432/x")
