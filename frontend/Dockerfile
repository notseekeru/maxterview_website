FROM node:lts-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS base

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

RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.5@sha256:f4a6f1ea26f4e500265b60b1935f2a5a0bc0cc5da4ca02ec32b2099426612229 AS prod

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
