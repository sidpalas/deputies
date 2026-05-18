FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/www/package.json apps/www/package.json
COPY packages/sandbox-bridge/package.json packages/sandbox-bridge/package.json

RUN pnpm install --frozen-lockfile

COPY apps/www apps/www

RUN pnpm --dir apps/www build

FROM caddy:2.10-alpine AS runtime

ENV PORT=8080

COPY apps/www/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/www/dist /usr/share/caddy

EXPOSE 8080
