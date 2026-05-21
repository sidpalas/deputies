ARG DEPUTIES_SANDBOX_BASE_IMAGE=deputies-sandbox-base:local
FROM ${DEPUTIES_SANDBOX_BASE_IMAGE}

# Docker provider image. The shared base provides the sandbox toolchain and
# bridge payload; this layer adds the Docker provider runtime contract.
ENV PGDATA=/home/sandbox/.deputies/postgres
ENV PATH=/usr/lib/postgresql/16/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DEPUTIES_WORKSPACE=/workspace
ENV DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0
ENV DEPUTIES_SANDBOX_BRIDGE_PORT=3584

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql postgresql-contrib \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash sandbox \
  && usermod -aG sudo sandbox \
  && printf 'sandbox ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/sandbox \
  && chmod 0440 /etc/sudoers.d/sandbox \
  && mkdir -p /workspace \
  && chown -R sandbox:sandbox /workspace /home/sandbox /opt/deputies

# The base image leaves Playwright out by default. The provider example images
# include Chromium because many coding-agent repos need browser test support.
RUN pnpm dlx playwright@1.59.1 install --with-deps chromium

USER sandbox
WORKDIR /workspace

RUN git lfs install --skip-repo

EXPOSE 3584

CMD ["node", "/opt/deputies/sandbox-bridge/dist/server.js"]
