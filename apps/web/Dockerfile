FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web

ARG VITE_API_BASE_URL=http://localhost:3583
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --dir apps/web build

FROM nginx:1.29-alpine AS runtime

ENV PORT=5173

COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 5173
