ARG DEPUTIES_SANDBOX_BASE_IMAGE=deputies-sandbox-base:local
FROM ${DEPUTIES_SANDBOX_BASE_IMAGE}

# Daytona provider image. The shared base provides the sandbox toolchain and
# bridge payload; Daytona supplies exec/filesystem APIs outside the container,
# so this image only needs a long-running command.
ENV PGDATA=/home/daytona/.deputies/postgres
ENV PATH=/usr/lib/postgresql/16/bin:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql postgresql-contrib \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash daytona \
  && usermod -aG sudo daytona \
  && printf 'daytona ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/daytona \
  && chmod 0440 /etc/sudoers.d/daytona \
  && mkdir -p /workspace \
  && chown -R daytona:daytona /workspace /home/daytona /opt/deputies

# The base image leaves Playwright out by default. The provider example images
# include Chromium because many coding-agent repos need browser test support.
RUN pnpm dlx playwright@1.59.1 install --with-deps chromium

USER daytona
WORKDIR /workspace

RUN git lfs install --skip-repo

# Daytona snapshots require a long-running command. If omitted, Daytona uses
# sleep infinity by default; keep it explicit for local Docker smoke tests too.
CMD ["sleep", "infinity"]
