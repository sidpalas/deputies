FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

COPY apps/control-plane apps/control-plane
RUN pnpm --dir apps/control-plane build \
  && cp -R apps/control-plane/src/db/migrations apps/control-plane/dist/db/migrations

FROM node:24-alpine AS prod-deps

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --prod --frozen-lockfile --filter deputies-control-plane

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache docker-cli github-cli

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/control-plane/node_modules ./apps/control-plane/node_modules
COPY --from=prod-deps --chown=node:node /app/apps/control-plane/package.json ./apps/control-plane/package.json
COPY --from=build --chown=node:node /app/apps/control-plane/dist ./apps/control-plane/dist

EXPOSE 3583
USER node
CMD ["node", "apps/control-plane/dist/index.js"]
