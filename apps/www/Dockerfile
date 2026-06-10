FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/www/package.json apps/www/package.json
COPY packages/sandbox-bridge/package.json packages/sandbox-bridge/package.json
COPY packages/browser-milestones packages/browser-milestones

RUN pnpm install --frozen-lockfile && pnpm rebuild sharp

COPY apps/web apps/web
COPY apps/www apps/www

RUN pnpm --dir apps/web build:static-demo && pnpm --dir apps/www build

FROM caddy:2.11-alpine AS runtime

ENV PORT=8080

COPY apps/www/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/www/dist /usr/share/caddy

EXPOSE 8080
