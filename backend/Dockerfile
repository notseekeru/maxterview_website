# --- BASE: uv-managed deps, non-root user (mirrors frontend multi-stage style)
FROM python:3.13-slim AS base

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

# Install uv pinned to a released version (reproducible)
COPY --from=ghcr.io/astral-sh/uv:0.7 /uv /uvx /bin/

# Cache deps on the lockfile alone, then mount source
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY --chown=appuser:appuser . .

USER appuser

# --- DEV: hot reload, bind-mount source via compose
FROM base AS dev

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

# --- PROD: no dev deps, no reload
FROM base AS prod

ENV APP_ENV=production

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
