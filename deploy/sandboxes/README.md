# Sandbox Images

This directory contains sandbox runtime image assets. These images are not full Deputies app deployments; they are execution environments used by sandbox providers when running agent work.

## Image Layers

- `base/`: provider-neutral base toolchain for Deputies-compatible sandboxes.
- `docker/`: Docker-provider image. It uses the base toolchain and starts the Deputies sandbox bridge as its command.
- `daytona/`: Daytona-provider image. It uses the base toolchain, adds helper scripts for Daytona/no-nested-virtualization verification, and uses a long-running command.
- `superserve/`: Superserve custom-template image. It enforces the provider's Linux/amd64 and glibc requirements and includes the authenticated Deputies bridge.

## Custom Repository Images

Use the published provider images directly unless you need extra tools or unpublished image changes:

```sh
DOCKER_SANDBOX_IMAGE=ghcr.io/sidpalas/deputies-docker-sandbox:<tag-or-digest>
DAYTONA_IMAGE=ghcr.io/sidpalas/deputies-daytona-sandbox:<tag-or-digest>
```

The provided images intentionally include only broadly useful dependencies. Most real repositories need additional language runtimes, system packages, CLIs, browser dependencies, database clients, or build tools.

Create a derivative image for your repo instead of editing the provider image directly. Start from the provider image that matches your sandbox provider so the provider startup contract remains intact.

Docker provider example:

```Dockerfile
FROM ghcr.io/<owner>/deputies-docker-sandbox:<tag>

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
USER sandbox
```

Then configure:

```sh
DOCKER_SANDBOX_IMAGE=ghcr.io/<owner>/<repo>-deputies-docker-sandbox:<tag>
```

Daytona provider example:

```Dockerfile
FROM ghcr.io/<owner>/deputies-daytona-sandbox:<tag>

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
USER daytona
```

Then configure:

```sh
DAYTONA_IMAGE=ghcr.io/<owner>/<repo>-deputies-daytona-sandbox:<tag>
```

Use pinned tags or digests for repeatability. Avoid relying on nested Docker unless your sandbox provider explicitly supports it.

Build provider images locally only when changing these Dockerfiles. Build the base first:

```sh
docker build -f deploy/sandboxes/base/Dockerfile -t deputies-sandbox-base:local .
docker build -f deploy/sandboxes/docker/Dockerfile -t deputies-sandbox:local .
```
