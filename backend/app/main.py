import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import close_pool, init_pool

APP_ENV = os.getenv("APP_ENV", "development")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# D2: no unauthenticated boot outside development/test.
if os.getenv("CLERK_ENABLED", "false").lower() == "false" and APP_ENV not in (
    "development",
    "test",
):
    raise RuntimeError("CLERK_ENABLED=false is only allowed when APP_ENV is development or test; refusing to boot.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_pool()
    yield
    await close_pool()


app = FastAPI(title="maxterview", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    # No DB call — CD smoke runs with a dummy DATABASE_URL and no Postgres.
    return {"status": "ok"}
