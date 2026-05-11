# Docker Sandbox Image

This directory contains the Docker sandbox image used by the `docker` sandbox provider.

The image starts `deputies-sandbox-bridge`, an authenticated in-container HTTP bridge for sandbox command execution and filesystem operations.

It intentionally mirrors the Daytona sandbox tooling so agent tasks see a similar environment across providers:

- Ubuntu 24.04 base
- Node.js 24 and Corepack/pnpm
- Postgres and PostgreSQL client tools
- Git, Git LFS, SSH, jq, rsync, zsh, vim, and sudo

Playwright Chromium is intentionally optional because it adds significant image size. Build with `--build-arg INSTALL_PLAYWRIGHT=true` when browser e2e support is required inside Docker sandboxes.

Build locally:

```sh
docker build -f deploy/docker/Dockerfile -t deputies-sandbox:local .
```

Build with Playwright browser support:

```sh
docker build -f deploy/docker/Dockerfile --build-arg INSTALL_PLAYWRIGHT=true -t deputies-sandbox:playwright .
```

Run a smoke-test container:

```sh
docker run --rm -p 3584:3584 -e DEPUTIES_SANDBOX_TOKEN=test-token deputies-sandbox:local
```

The bridge listens on port `3584` and requires `Authorization: Bearer <DEPUTIES_SANDBOX_TOKEN>` for every request.

## Relationship To Daytona Image

This image and `deploy/daytona/Dockerfile` intentionally share the same Ubuntu base and core toolset. They differ at the provider boundary and browser default:

- Daytona uses `CMD ["sleep", "infinity"]` because Daytona supplies exec/filesystem APIs outside the container.
- Docker uses `CMD ["node", "/opt/deputies/sandbox-bridge/dist/server.js"]` because the Docker provider talks to the in-container bridge.
- Daytona installs Playwright browsers by default for full sandbox checks; Docker makes that optional to keep local provider images smaller.

They could be collapsed into one image with provider-specific command overrides, but keeping sibling Dockerfiles makes each provider's startup contract explicit while preserving a consistent sandbox environment.
