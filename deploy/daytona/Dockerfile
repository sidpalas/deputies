FROM mcr.microsoft.com/playwright:v1.59.1-noble

ENV DEBIAN_FRONTEND=noninteractive
ENV PGDATA=/home/daytona/.deputies/postgres
ENV PATH=/usr/lib/postgresql/16/bin:$PATH

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
    vim \
    zsh \
  && corepack enable \
  && curl https://mise.run | sh \
  && mv /root/.local/bin/mise /usr/local/bin/mise \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash daytona \
  && usermod -aG sudo daytona \
  && printf 'daytona ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/daytona \
  && chmod 0440 /etc/sudoers.d/daytona \
  && mkdir -p /workspace \
  && chown -R daytona:daytona /workspace /home/daytona

USER daytona
WORKDIR /workspace

RUN git lfs install --skip-repo

# Daytona snapshots require a long-running command. If omitted, Daytona uses
# sleep infinity by default; keep it explicit for local Docker smoke tests too.
CMD ["sleep", "infinity"]
