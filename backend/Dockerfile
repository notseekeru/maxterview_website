FROM python:3.14-slim@sha256:c3e521df8b2b498a7a682e7e18676771cb80c6b75b8699af886b2d554ce40151 AS base

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

RUN useradd --create-home --shell /bin/bash appuser

# The resume preview compiles LaTeX in this image (app/latex.py). A resume needs geometry, enumitem,
# titlesec, hyperref, xcolor and microtype (enumitem/titlesec ship in latex-extra), a text font
# (lmodern), and the icon glyphs the common templates put in contact lines: fontawesome5 and
# fontawesome v4, which Debian only ships inside fonts-extra.
# fonts-extra carries every font family on CTAN, which a resume never loads, so it is installed and
# then cut back to those two icon families; ls-R and the font map are rebuilt from what is left, and a
# template asking for anything cut fails with the package named. Removing the trees below is safe for
# pdflatex: it reads type1 + tfm, never the opentype, sources or documentation copies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra lmodern \
    && dpkg -L texlive-fonts-extra | grep -Ev '/(fontawesome5|fontawesome)/' | while read -r file; do if [ -f "$file" ]; then rm -f "$file"; fi; done \
    && rm -rf /usr/share/texlive/texmf-dist/doc /usr/share/texlive/texmf-dist/source /usr/share/doc /usr/share/man \
    && find /usr/share/texlive/texmf-dist -type d -empty -delete \
    && mktexlsr \
    && rm -f /etc/texmf/web2c/updmap.cfg \
    && yes | updmap-sys --syncwithtrees \
    && updmap-sys \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

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
