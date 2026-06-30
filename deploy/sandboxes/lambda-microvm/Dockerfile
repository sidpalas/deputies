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
ENV PGDATA=/root/.deputies/postgres
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
    docker-cli \
    docker.io \
    fd-find \
    ffmpeg \
    git \
    git-lfs \
    iptables \
    jq \
    openssh-client \
    postgresql \
    postgresql-contrib \
    ripgrep \
    rsync \
    unzip \
    vim \
    zsh \
  && command -v docker \
  && command -v dockerd

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

RUN <<'EOF'
set -eux
mkdir -p /workspace /opt/deputies /root/.deputies
cat > /usr/local/bin/sudo <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -eq 0 ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --) shift; break ;;
      -A|-b|-E|-H|-h|-K|-k|-n|-P|-S|-v) shift ;;
      -C|-D|-g|-p|-R|-r|-t|-T|-u) shift 2 ;;
      -*) shift ;;
      *) break ;;
    esac
  done
  if [ "$#" -eq 0 ]; then exit 0; fi
  exec "$@"
fi
exec /usr/bin/sudo "$@"
SCRIPT
chmod 0755 /usr/local/bin/sudo
cat > /usr/local/bin/docker <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

real_docker=/usr/bin/docker
docker_host="${DOCKER_HOST:-unix:///var/run/docker.sock}"
export DOCKER_HOST="$docker_host"

dockerd_is_running() {
  local comm
  for comm in /proc/[0-9]*/comm; do
    if [ "$(cat "$comm" 2>/dev/null || true)" = dockerd ]; then return 0; fi
  done
  return 1
}

if [ "${DEPUTIES_START_DOCKER:-1}" = "0" ]; then
  exec "$real_docker" "$@"
fi

if "$real_docker" info >/dev/null 2>&1; then
  exec "$real_docker" "$@"
fi

lock_dir=/var/run/deputies-docker-start.lock
lock_acquired=0
if mkdir "$lock_dir" 2>/dev/null; then
  lock_acquired=1
  if ! "$real_docker" info >/dev/null 2>&1 && ! dockerd_is_running; then
    mkdir -p /var/run /var/lib/docker /var/log
    docker_dns="${DEPUTIES_DOCKER_DNS:-169.254.169.253}"
    dockerd_args=(--host="$docker_host" --storage-driver=vfs)
    if [ -n "$docker_dns" ]; then dockerd_args+=(--dns="$docker_dns"); fi
    /usr/sbin/dockerd "${dockerd_args[@]}" >/var/log/deputies-dockerd.log 2>&1 &
  fi
fi

timeout_seconds="${DEPUTIES_DOCKER_READY_TIMEOUT_SECONDS:-45}"
deadline=$((SECONDS + timeout_seconds))
until "$real_docker" info >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "dockerd did not become ready within ${timeout_seconds}s" >&2
    if [ -f /var/log/deputies-dockerd.log ]; then
      echo "--- dockerd log ---" >&2
      tail -n 120 /var/log/deputies-dockerd.log >&2 || true
    fi
    if [ "$lock_acquired" -eq 1 ]; then rmdir "$lock_dir" 2>/dev/null || true; fi
    exit 1
  fi
  sleep 0.5
done

if [ "$lock_acquired" -eq 1 ]; then rmdir "$lock_dir" 2>/dev/null || true; fi
exec "$real_docker" "$@"
SCRIPT
chmod 0755 /usr/local/bin/docker
EOF

COPY sandbox-bridge /opt/deputies/sandbox-bridge
COPY --chmod=0755 start-bridge.sh /opt/deputies/start-bridge.sh
COPY lambda-microvm-runtime.mjs runtime-config.mjs /opt/deputies/
COPY --from=playwright-browsers --chown=root:root /ms-playwright /ms-playwright

WORKDIR /workspace

RUN git lfs install --skip-repo

EXPOSE 9000 3584

CMD ["node", "/opt/deputies/lambda-microvm-runtime.mjs"]
