# Docker Sandbox Image

This directory contains the Docker sandbox image used by the `docker` sandbox provider.

The image starts `deputies-sandbox-bridge`, an authenticated in-container HTTP bridge for sandbox command execution and filesystem operations.

It intentionally mirrors the Daytona sandbox tooling so agent tasks see a similar environment across providers:

- Ubuntu 24.04 base
- Node.js 24 and Corepack/pnpm
- Postgres and PostgreSQL client tools installed on top of the base for this repo's test workflow
- Playwright Chromium, its video helper, Linux browser dependencies, and the `deputies-record` demo CLI
- System ffmpeg for MP4 transcoding and media inspection
- Baseline DejaVu, Liberation, Noto, and Noto Color Emoji fonts with fontconfig
- `agent-browser` for stateful interactive verification using the bundled Chromium
- `tini` as PID 1 so idle browser daemons are reaped cleanly
- Git, Git LFS, SSH, jq, rsync, zsh, vim, and sudo

The shared base leaves Postgres and Playwright out by default. This Docker-provider example image includes both because this repo's full checks need database and browser test support. Derivative images may remove or replace them if their workload does not need them.

### Project-Specific Fonts

The baseline set covers common browser defaults, not every proprietary or project-specific typeface. Prefer repository-owned `@font-face` assets for deterministic local, CI, and sandbox rendering. Applications that intentionally depend on another system font should derive a custom image:

```dockerfile
FROM ghcr.io/sidpalas/deputies-docker-sandbox:latest
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*
USER sandbox
```

For licensed fonts, copy them from an authorized build context into `/usr/local/share/fonts/<project>/`, run `fc-cache -f`, and verify redistribution rights. During capture, wait for `document.fonts.ready` and treat failed font requests or fallback rendering as a verification failure.

Use the published image for normal local development:

```sh
docker pull ghcr.io/sidpalas/deputies-docker-sandbox:latest
```

Build locally only when changing this image:

```sh
docker build -f deploy/sandboxes/base/Dockerfile -t deputies-sandbox-base:local .
docker build -f deploy/sandboxes/docker/Dockerfile -t deputies-sandbox:local .
```

Run a smoke-test container:

```sh
docker run --rm -p 3584:3584 -e DEPUTIES_SANDBOX_TOKEN=test-token ghcr.io/sidpalas/deputies-docker-sandbox:latest
```

The bridge listens on port `3584` and requires `Authorization: Bearer <DEPUTIES_SANDBOX_TOKEN>` for every request.

## Relationship To Daytona Image

This image and `deploy/sandboxes/daytona/Dockerfile` intentionally build on the same base image and add the same broad browser-test support. They differ primarily at the provider runtime contract:

- Daytona uses `CMD ["sleep", "infinity"]` because Daytona supplies exec/filesystem APIs outside the container.
- Docker uses `CMD ["node", "/opt/deputies/sandbox-bridge/dist/server.js"]` because the Docker provider talks to the in-container bridge.
- The provider images use different default users and provider-specific environment variables.

They could be collapsed into one image with provider-specific command overrides, but keeping sibling Dockerfiles makes each provider's startup contract explicit while preserving a consistent sandbox environment.
