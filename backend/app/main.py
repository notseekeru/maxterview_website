import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import engine

APP_ENV = os.getenv("APP_ENV", "development")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# D2 guard: Clerk fallback is only legal in development/test. Without Clerk,
# refuse to boot anywhere else — no silent unauthenticated prod.
if os.getenv("CLERK_ENABLED", "false").lower() == "false" and APP_ENV not in (
    "development",
    "test",
):
    raise RuntimeError("CLERK_ENABLED=false is only allowed when APP_ENV is development or test; refusing to boot.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Startup: init structlog here.
    yield
    # Shutdown: dispose the DB engine.
    await engine.dispose()


app = FastAPI(title="maxterview", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    # No internals, no DB call — CD smoke test (dummy DATABASE_URL, no Postgres)
    # depends on this returning 200 without touching the database.
    return {"status": "ok"}
