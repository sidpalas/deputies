# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS bridge-build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY packages/sandbox-bridge/package.json packages/sandbox-bridge/package.json

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
  corepack enable && pnpm install --filter @deputies/sandbox-bridge... --frozen-lockfile

COPY packages/sandbox-bridge packages/sandbox-bridge

RUN pnpm --dir packages/sandbox-bridge build

FROM ubuntu:24.04

# Provider-neutral Deputies sandbox base. Provider-specific images should add
# their startup contract on top of this toolchain, such as the Docker bridge or
# a long-running Daytona command.
ENV DEBIAN_FRONTEND=noninteractive

ARG CODE_SERVER_VERSION=4.118.0
ARG HUNKDIFF_VERSION=0.12.1

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    git-lfs \
    gnupg \
    fd-find \
    jq \
    openssh-client \
    ripgrep \
    rsync \
    sudo \
    ttyd \
    vim \
    zsh

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && corepack enable \
  && curl -fsSL https://code-server.dev/install.sh | sh -s -- --version "${CODE_SERVER_VERSION}" \
  && npm install -g "hunkdiff@${HUNKDIFF_VERSION}" \
  && curl -fsSL https://mise.run | sh \
  && mv /root/.local/bin/mise /usr/local/bin/mise

RUN mkdir -p /opt/deputies/sandbox-bridge

COPY --from=bridge-build /app/packages/sandbox-bridge/dist /opt/deputies/sandbox-bridge/dist
COPY --from=bridge-build /app/packages/sandbox-bridge/package.json /opt/deputies/sandbox-bridge/package.json
