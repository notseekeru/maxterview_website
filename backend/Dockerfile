FROM python:3.15-slim@sha256:044d5bd747976e21f8bc4d746c3479b19a84bb8ae6261b802acdd26b29036c93 AS base

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.13@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff /uv /uvx /bin/

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project && chown -R appuser:appuser /app/.venv

COPY --chown=appuser:appuser . .

RUN uv sync --frozen --no-dev

USER appuser

FROM base AS dev

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM base AS prod

# Base image snapshots lag Debian point releases (deb13uN); patch OS packages at build.
USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold \
        upgrade --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
USER appuser

ENV APP_ENV=production

EXPOSE 8000

CMD [".venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
