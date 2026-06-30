# syntax=docker/dockerfile:1.7

ARG PLAYWRIGHT_VERSION=1.59.1
ARG PLAYWRIGHT_CHROMIUM_REVISION=1217
ARG PLAYWRIGHT_CHROMIUM_VERSION=147.0.7727.15
ARG PLAYWRIGHT_INSTALL_TIMEOUT=12m
ARG CODE_SERVER_VERSION=4.118.0
ARG HUNKDIFF_VERSION=0.12.1
ARG TTYD_VERSION=1.7.7

FROM node:24-trixie-slim AS playwright-browsers
ARG TARGETARCH
ARG PLAYWRIGHT_CHROMIUM_REVISION
ARG PLAYWRIGHT_CHROMIUM_VERSION
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip

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

FROM node:24-trixie-slim
ARG PLAYWRIGHT_VERSION
ARG PLAYWRIGHT_INSTALL_TIMEOUT
ARG CODE_SERVER_VERSION
ARG HUNKDIFF_VERSION
ARG TTYD_VERSION
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV PGDATA=/home/sandbox/.deputies/postgres
ENV PATH=/usr/lib/postgresql/16/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DEPUTIES_WORKSPACE=/workspace
ENV DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0
ENV DEPUTIES_SANDBOX_BRIDGE_PORT=3584

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fd-find \
    git \
    git-lfs \
    jq \
    openssh-client \
    postgresql \
    postgresql-contrib \
    ripgrep \
    rsync \
    sudo \
    unzip \
    vim \
    zsh

RUN curl -fsSL https://code-server.dev/install.sh | sh -s -- --version "${CODE_SERVER_VERSION}"

RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) ttyd_arch="x86_64" ;; \
    arm64) ttyd_arch="aarch64" ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  base_url="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}"; \
  curl -fsSL -o /tmp/ttyd "${base_url}/ttyd.${ttyd_arch}"; \
  curl -fsSL -o /tmp/ttyd.SHA256SUMS "${base_url}/SHA256SUMS"; \
  grep " ttyd.${ttyd_arch}$" /tmp/ttyd.SHA256SUMS | sed "s/ttyd.${ttyd_arch}/ttyd/" > /tmp/ttyd.sha256; \
  (cd /tmp && sha256sum -c ttyd.sha256); \
  install -m 0755 /tmp/ttyd /usr/local/bin/ttyd; \
  rm -f /tmp/ttyd /tmp/ttyd.SHA256SUMS /tmp/ttyd.sha256

RUN --mount=type=cache,target=/root/.npm \
  npm install -g "hunkdiff@${HUNKDIFF_VERSION}" "playwright@${PLAYWRIGHT_VERSION}"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  DEBUG=pw:install PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    timeout "${PLAYWRIGHT_INSTALL_TIMEOUT}" playwright install-deps chromium

RUN curl -fsSL https://mise.run | sh \
  && mv /root/.local/bin/mise /usr/local/bin/mise

RUN useradd -m -s /bin/bash sandbox \
  && usermod -aG sudo sandbox \
  && printf 'sandbox ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/sandbox \
  && chmod 0440 /etc/sudoers.d/sandbox \
  && mkdir -p /workspace /opt/deputies \
  && chown -R sandbox:sandbox /workspace /home/sandbox /opt/deputies

COPY --chown=sandbox:sandbox sandbox-bridge /opt/deputies/sandbox-bridge
COPY --chmod=0755 start-bridge.sh /opt/deputies/start-bridge.sh
COPY --chown=sandbox:sandbox lambda-microvm-runtime.mjs /opt/deputies/lambda-microvm-runtime.mjs
COPY --from=playwright-browsers --chown=root:root /ms-playwright /ms-playwright

USER sandbox
WORKDIR /workspace

RUN git lfs install --skip-repo

EXPOSE 9000 3584

CMD ["node", "/opt/deputies/lambda-microvm-runtime.mjs"]
