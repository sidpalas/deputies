# syntax=docker/dockerfile:1.7

FROM ghcr.io/sidpalas/deputies-sandbox-base:latest

ARG TARGETARCH
ARG PLAYWRIGHT_VERSION=1.59.1
ARG PLAYWRIGHT_CHROMIUM_REVISION=1217
ARG PLAYWRIGHT_CHROMIUM_VERSION=147.0.7727.15
ARG PLAYWRIGHT_INSTALL_TIMEOUT=12m

# Superserve custom images must be linux/amd64 and glibc-based. Fail the build
# if either part of that contract changes accidentally.
RUN test "${TARGETARCH}" = amd64 \
  && test "$(dpkg --print-architecture)" = amd64 \
  && getconf GNU_LIBC_VERSION

ENV DEBIAN_FRONTEND=noninteractive
ENV PGDATA=/home/sandbox/.deputies/postgres
ENV PATH=/usr/lib/postgresql/16/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql postgresql-contrib unzip \
  && rm -rf /var/lib/apt/lists/*

RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g "playwright@${PLAYWRIGHT_VERSION}"

RUN apt-get update \
  && DEBUG=pw:install PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    timeout "${PLAYWRIGHT_INSTALL_TIMEOUT}" playwright install-deps chromium

RUN set -eux; \
  browser_dir="/ms-playwright/chromium-${PLAYWRIGHT_CHROMIUM_REVISION}"; \
  mkdir -p "${browser_dir}"; \
  curl -fL --retry 5 --retry-delay 2 --connect-timeout 30 --max-time 300 \
    -o /tmp/chromium.zip \
    "https://cdn.playwright.dev/builds/cft/${PLAYWRIGHT_CHROMIUM_VERSION}/linux64/chrome-linux64.zip"; \
  timeout 5m unzip -q /tmp/chromium.zip -d "${browser_dir}"; \
  chmod 0755 "${browser_dir}/chrome-linux64/chrome"; \
  touch "${browser_dir}/INSTALLATION_COMPLETE"; \
  chmod -R a+rX /ms-playwright; \
  rm -f /tmp/chromium.zip; \
  rm -rf /var/lib/apt/lists/*

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

CMD ["sleep", "infinity"]
