FROM node:24-bookworm-slim AS bridge-build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sandbox-bridge/package.json packages/sandbox-bridge/package.json

RUN corepack enable && pnpm install --filter @deputies/sandbox-bridge... --frozen-lockfile

COPY packages/sandbox-bridge packages/sandbox-bridge

RUN pnpm --dir packages/sandbox-bridge build

FROM ubuntu:24.04

# Keep this image's base OS and sandbox toolchain aligned with
# deploy/daytona/Dockerfile. The provider-specific difference is the command:
# Daytona keeps the container alive while Daytona supplies exec/filesystem APIs;
# Docker starts the Deputies sandbox bridge.
ARG INSTALL_PLAYWRIGHT=false
ARG CODE_SERVER_VERSION=4.118.0
ARG HUNKDIFF_VERSION=0.12.1
ENV DEBIAN_FRONTEND=noninteractive
ENV PGDATA=/home/sandbox/.deputies/postgres
ENV PATH=/usr/lib/postgresql/16/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DEPUTIES_WORKSPACE=/workspace
ENV DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0
ENV DEPUTIES_SANDBOX_BRIDGE_PORT=3584

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    git-lfs \
    gnupg \
    jq \
    openssh-client \
    postgresql \
    postgresql-contrib \
    rsync \
    sudo \
    ttyd \
    vim \
    zsh \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && corepack enable \
  && curl -fsSL https://code-server.dev/install.sh | sh -s -- --version "${CODE_SERVER_VERSION}" \
  && npm install -g "hunkdiff@${HUNKDIFF_VERSION}" \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then \
    pnpm dlx playwright@1.59.1 install --with-deps chromium; \
  fi

RUN useradd -m -s /bin/bash sandbox \
  && usermod -aG sudo sandbox \
  && printf 'sandbox ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/sandbox \
  && chmod 0440 /etc/sudoers.d/sandbox \
  && mkdir -p /workspace /opt/deputies/sandbox-bridge \
  && chown -R sandbox:sandbox /workspace /home/sandbox /opt/deputies

COPY --from=bridge-build --chown=sandbox:sandbox /app/packages/sandbox-bridge/dist /opt/deputies/sandbox-bridge/dist
COPY --from=bridge-build --chown=sandbox:sandbox /app/packages/sandbox-bridge/package.json /opt/deputies/sandbox-bridge/package.json

USER sandbox
WORKDIR /workspace

RUN git lfs install --skip-repo

EXPOSE 3584

CMD ["node", "/opt/deputies/sandbox-bridge/dist/server.js"]
