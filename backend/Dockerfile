FROM node:26-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

FROM deps AS build

COPY tsconfig.json tsconfig.scripts.json ./
COPY src ./src
COPY scripts/migrate.ts ./scripts/

RUN npm run build

FROM node:26-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

FROM node:26-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS runtime

# The resume preview shells out to pdflatex (src/latex.ts) and 503s without it. Same package set as the
# Python image: the shipped preamble needs geometry, fontenc, lmodern, enumitem, titlesec and hyperref,
# all covered by latex-extra. texlive-fonts-extra stays out: its families are never loaded.
RUN apt-get update \
    && apt-get install -y --no-install-recommends texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended lmodern \
    && rm -rf /usr/share/texlive/texmf-dist/doc /usr/share/texlive/texmf-dist/source /usr/share/doc /usr/share/man \
    && find /usr/share/texlive/texmf-dist -type d -empty -delete \
    && mktexlsr \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

FROM runtime AS dev

COPY --from=deps /app/node_modules ./node_modules
COPY src ./src

USER root

CMD ["node", "--run", "dev"]

# APP_ENV is the deploy's to set: baking one here would decide production vs. development for every cluster.
FROM runtime AS prod

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

USER node

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=20s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/main.js"]
