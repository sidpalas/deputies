# syntax=docker/dockerfile:1.7

ARG DEPUTIES_SANDBOX_BASE_IMAGE=deputies-sandbox-base:local
ARG PLAYWRIGHT_VERSION=1.59.1
ARG PLAYWRIGHT_CHROMIUM_REVISION=1217
ARG PLAYWRIGHT_CHROMIUM_VERSION=147.0.7727.15
ARG PLAYWRIGHT_FFMPEG_REVISION=1011
ARG PLAYWRIGHT_INSTALL_TIMEOUT=12m
ARG AGENT_BROWSER_VERSION=0.31.1

FROM node:24-trixie-slim AS playwright-browsers
ARG TARGETARCH
ARG PLAYWRIGHT_CHROMIUM_REVISION
ARG PLAYWRIGHT_CHROMIUM_VERSION
ARG PLAYWRIGHT_FFMPEG_REVISION
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

RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) \
      ffmpeg_archive="ffmpeg-linux.zip"; \
      ffmpeg_sha256="ebc74fc5b94830176a3c2914ae96bd8bc7f6a91f4f33890230f84a172ee61ccc"; \
      ;; \
    arm64) \
      ffmpeg_archive="ffmpeg-linux-arm64.zip"; \
      ffmpeg_sha256="2628c03f05318ff812c8c9baaf207dea2ddf53e818c0dc936714b0fbe3afb009"; \
      ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  ffmpeg_dir="/ms-playwright/ffmpeg-${PLAYWRIGHT_FFMPEG_REVISION}"; \
  mkdir -p "${ffmpeg_dir}"; \
  curl -fL --retry 5 --retry-delay 2 --connect-timeout 30 --max-time 300 \
    -o /tmp/playwright-ffmpeg.zip \
    "https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/${PLAYWRIGHT_FFMPEG_REVISION}/${ffmpeg_archive}"; \
  echo "${ffmpeg_sha256}  /tmp/playwright-ffmpeg.zip" | sha256sum --check; \
  timeout 2m unzip -q /tmp/playwright-ffmpeg.zip -d "${ffmpeg_dir}"; \
  touch "${ffmpeg_dir}/INSTALLATION_COMPLETE"; \
  chmod -R a+rX /ms-playwright; \
  rm -f /tmp/playwright-ffmpeg.zip

FROM ${DEPUTIES_SANDBOX_BASE_IMAGE}
ARG TARGETARCH
ARG AGENT_BROWSER_VERSION
ARG PLAYWRIGHT_CHROMIUM_REVISION
ARG PLAYWRIGHT_VERSION
ARG PLAYWRIGHT_INSTALL_TIMEOUT

# Docker provider image. The shared base provides the sandbox toolchain and
# bridge payload; this layer adds the Docker provider runtime contract.
ENV PGDATA=/home/sandbox/.deputies/postgres
ENV PATH=/usr/lib/postgresql/16/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/deputies-chromium
ENV AGENT_BROWSER_IDLE_TIMEOUT_MS=120000
ENV DEPUTIES_WORKSPACE=/workspace
ENV DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0
ENV DEPUTIES_SANDBOX_BRIDGE_PORT=3584

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-core \
    postgresql \
    postgresql-contrib \
    tini

RUN --mount=type=cache,target=/root/.npm \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g \
    "playwright@${PLAYWRIGHT_VERSION}" \
    /opt/deputies/browser-demo-recorder/package.tgz

RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) agent_browser_arch="x64"; agent_browser_sha256="72c13bcfd2fd6b188325bdd23c646d06ca69a1a964a9cdaab37e4ff8f47aa5c6" ;; \
    arm64) agent_browser_arch="arm64"; agent_browser_sha256="5f80bff26b25e9a9f712be64dda1f8ea2b22213a1a07c0f97ea8f9f226c2894b" ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fL --retry 5 --retry-delay 2 --connect-timeout 30 --max-time 300 \
    -o /tmp/agent-browser \
    "https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-linux-${agent_browser_arch}"; \
  echo "${agent_browser_sha256}  /tmp/agent-browser" | sha256sum --check; \
  install -m 0755 /tmp/agent-browser /usr/local/bin/agent-browser; \
  rm -f /tmp/agent-browser; \
  case "${TARGETARCH}" in \
    amd64) chromium_path="/ms-playwright/chromium-${PLAYWRIGHT_CHROMIUM_REVISION}/chrome-linux64/chrome" ;; \
    arm64) chromium_path="/ms-playwright/chromium-${PLAYWRIGHT_CHROMIUM_REVISION}/chrome-linux/chrome" ;; \
  esac; \
  ln -s "${chromium_path}" /usr/local/bin/deputies-chromium

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  DEBUG=pw:install PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    timeout "${PLAYWRIGHT_INSTALL_TIMEOUT}" playwright install-deps chromium

RUN useradd -m -s /bin/bash sandbox \
  && usermod -aG sudo sandbox \
  && printf 'sandbox ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/sandbox \
  && chmod 0440 /etc/sudoers.d/sandbox \
  && mkdir -p /workspace \
  && chown -R sandbox:sandbox /workspace /home/sandbox /opt/deputies

COPY --chmod=0755 deploy/sandboxes/docker/start-bridge.sh /opt/deputies/start-bridge.sh

USER sandbox
WORKDIR /workspace

RUN git lfs install --skip-repo

COPY --from=playwright-browsers --chown=root:root /ms-playwright /ms-playwright

EXPOSE 3584

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/deputies/start-bridge.sh"]
