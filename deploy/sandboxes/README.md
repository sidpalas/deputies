# Sandbox Images

This directory contains sandbox runtime image assets. These images are not full Deputies app deployments; they are execution environments used by sandbox providers when running agent work.

## Image Layers

- `base/`: provider-neutral base toolchain for Deputies-compatible sandboxes.
- `docker/`: Docker-provider image. It uses the base toolchain and starts the Deputies sandbox bridge as its command.
- `daytona/`: Daytona-provider image. It uses the base toolchain, adds helper scripts for Daytona/no-nested-virtualization verification, and uses a long-running command.
- `opencomputer/`: OpenComputer snapshot workflow. It installs sandbox tooling through the OpenComputer SDK image builder, with bridge, minimal, slim, and full variants.

## Custom Repository Images

Use the published provider images directly unless you need extra tools or unpublished image changes:

```sh
DOCKER_SANDBOX_IMAGE=ghcr.io/sidpalas/deputies-docker-sandbox:<tag-or-digest>
DAYTONA_IMAGE=ghcr.io/sidpalas/deputies-daytona-sandbox:<tag-or-digest>
OPENCOMPUTER_SNAPSHOT=<snapshot-name>
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

OpenComputer snapshots are created through the SDK rather than Docker:

```sh
mise run //deploy/sandboxes/opencomputer:snapshot:create
mise run //deploy/sandboxes/opencomputer:snapshot:create:bridge
mise run //deploy/sandboxes/opencomputer:snapshot:create:slim
mise run //deploy/sandboxes/opencomputer:snapshot:create:full
```

The default OpenComputer snapshot task currently creates the validated bridge variant, `deputies-opencomputer-base-bridge`.

Build provider images locally only when changing these Dockerfiles. Build the base first:

```sh
docker build -f deploy/sandboxes/base/Dockerfile -t deputies-sandbox-base:local .
docker build -f deploy/sandboxes/docker/Dockerfile -t deputies-sandbox:local .
```
