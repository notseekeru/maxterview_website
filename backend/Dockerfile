FROM python:3.14-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f AS base

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

RUN useradd --create-home --shell /bin/bash appuser

# The resume preview compiles LaTeX in this image (app/latex.py). The shipped preamble
# (frontend/src/lib/toLatex.ts) loads only geometry, fontenc, lmodern, enumitem, titlesec and hyperref,
# all of which latex-extra covers. texlive-fonts-extra is deliberately absent: it is 624MB of CTAN
# families that a resume never loads, bought to serve fontawesome5, which the generator never emits. A
# user-pasted template asking for those icons fails with the package named. Removing the doc and
# source trees below is safe for pdflatex: it reads type1 + tfm, never the opentype copies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended lmodern \
    && rm -rf /usr/share/texlive/texmf-dist/doc /usr/share/texlive/texmf-dist/source /usr/share/doc /usr/share/man \
    && find /usr/share/texlive/texmf-dist -type d -empty -delete \
    && mktexlsr \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.13@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 /uv /uvx /bin/

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

CMD [".venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "3"]
