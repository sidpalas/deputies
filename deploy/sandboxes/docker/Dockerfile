# syntax=docker/dockerfile:1.7

ARG DEPUTIES_SANDBOX_BASE_IMAGE=deputies-sandbox-base:local
ARG PLAYWRIGHT_VERSION=1.59.1
ARG PLAYWRIGHT_CHROMIUM_REVISION=1217
ARG PLAYWRIGHT_CHROMIUM_VERSION=147.0.7727.15
ARG PLAYWRIGHT_INSTALL_TIMEOUT=12m

FROM node:24-bookworm-slim AS playwright-browsers
ARG TARGETARCH
ARG PLAYWRIGHT_CHROMIUM_REVISION
ARG PLAYWRIGHT_CHROMIUM_VERSION
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip

# Playwright's bundled JS unzipper can hang after the browser download reaches
# 100% under BuildKit. Download Chrome for Testing directly and use system unzip.
RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) \
      chromium_url="https://cdn.playwright.dev/builds/cft/${PLAYWRIGHT_CHROMIUM_VERSION}/linux64/chrome-linux64.zip"; \
      executable_path="chrome-linux64/chrome"; \
      ;; \
    arm64) \
      chromium_url="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${PLAYWRIGHT_CHROMIUM_REVISION}/chromium-linux-arm64.zip"; \
      executable_path="chrome-linux/chrome"; \
      ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  browser_dir="/ms-playwright/chromium-${PLAYWRIGHT_CHROMIUM_REVISION}"; \
  mkdir -p "${browser_dir}"; \
  curl -fL --retry 5 --retry-delay 2 --connect-timeout 30 --max-time 300 \
    -o /tmp/chromium.zip "${chromium_url}"; \
  timeout 5m unzip -q /tmp/chromium.zip -d "${browser_dir}"; \
  chmod 0755 "${browser_dir}/${executable_path}"; \
  touch "${browser_dir}/INSTALLATION_COMPLETE"; \
  chmod -R a+rX /ms-playwright; \
  rm -f /tmp/chromium.zip

FROM ${DEPUTIES_SANDBOX_BASE_IMAGE}
ARG PLAYWRIGHT_VERSION
ARG PLAYWRIGHT_INSTALL_TIMEOUT

# Docker provider image. The shared base provides the sandbox toolchain and
# bridge payload; this layer adds the Docker provider runtime contract.
ENV PGDATA=/home/sandbox/.deputies/postgres
ENV PATH=/usr/lib/postgresql/16/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DEPUTIES_WORKSPACE=/workspace
ENV DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0
ENV DEPUTIES_SANDBOX_BRIDGE_PORT=3584

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  --mount=type=cache,target=/root/.npm \
  apt-get update \
  && apt-get install -y --no-install-recommends postgresql postgresql-contrib \
  && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
  && DEBUG=pw:install PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    timeout "${PLAYWRIGHT_INSTALL_TIMEOUT}" playwright install-deps chromium

COPY --from=playwright-browsers /ms-playwright /ms-playwright

RUN useradd -m -s /bin/bash sandbox \
  && usermod -aG sudo sandbox \
  && printf 'sandbox ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/sandbox \
  && chmod 0440 /etc/sudoers.d/sandbox \
  && mkdir -p /workspace \
  && chown -R sandbox:sandbox /workspace /home/sandbox /opt/deputies

USER sandbox
WORKDIR /workspace

RUN git lfs install --skip-repo

EXPOSE 3584

CMD ["node", "/opt/deputies/sandbox-bridge/dist/server.js"]
