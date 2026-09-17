FROM node:lts-alpine3.24@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS base

WORKDIR /app

COPY --chown=node:node package*.json ./

RUN chown node:node /app

USER node

RUN npm ci

COPY --chown=node:node . .

FROM base AS dev

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host"]

FROM base AS builder

# Two builds from one Dockerfile, chosen by mode (D14): the default reads the committed
# frontend/.env.production, while the staging image is built with --build-arg VITE_MODE=staging and
# reads frontend/.env.staging (the Development instance's pk_test_). Vite inlines VITE_* at build
# time, so the choice has to happen here — runtime injection via nginx config.js is the
# documented-but-unneeded alternative (9 files across 3 repos).
ARG VITE_MODE=production
RUN npm run build -- --mode "$VITE_MODE"

FROM nginxinc/nginx-unprivileged:1.31.6@sha256:e44b470e571b20d935336bfb9f8277c1468d15e1e4d105a12ab5609d0b4682cb AS prod

# Base image snapshots lag Debian point releases (deb13uN); patch OS packages at build.
# nginx itself is a local .deb at prio 100, so `upgrade` cannot un-pin the tag.
USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold \
        upgrade --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
USER 101

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
