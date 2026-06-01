# Docker Compose App Deployment

These Compose stacks run the full Deputies application locally in production-style containers. They are useful for smoke tests and local deployment rehearsal, not for the normal pnpm contributor workflow.

Common services:

- `postgres`: local Postgres database.
- `seaweedfs`: local S3-compatible object storage for stored artifacts.
- `control-plane-migrate`: one-shot database migration job.
- `web`: built Vite app served by Caddy, with API routes proxied to the API service.

The combined variant also runs:

- `control-plane`: compiled API and worker process, with Docker orchestration in-process.

The split variant also runs:

- `api`: API-only control-plane process.
- `worker`: worker-only control-plane process.
- `docker-orchestrator`: Docker sandbox orchestration service with Docker daemon access.

## Prerequisites

- Docker Desktop or compatible Docker Engine.
- `.env.local` in the repository root.
- Optional Codex subscription auth at `~/.pi/agent/auth.json`.

Copy `.env.example` to `.env.local` if needed:

```sh
cp .env.example .env.local
```

## Start The Stack

Combined API/worker:

```sh
docker compose -f deploy/docker-compose/docker-compose.combined.yml up -d --build
```

Split API/worker/orchestrator:

```sh
docker compose -f deploy/docker-compose/docker-compose.split.yml up -d --build
```

Scale split workers:

```sh
docker compose -f deploy/docker-compose/docker-compose.split.yml up -d --scale worker=4
```

Services are available at:

- Web: `http://localhost:5173`
- API direct: `http://localhost:3583`
- Postgres: `localhost:5432`
- SeaweedFS S3 API: `http://localhost:8333`

Check proxied API health:

```sh
curl http://localhost:5173/health
```

## Artifact Storage

The Compose stacks enable stored artifacts by default with SeaweedFS' S3-compatible API:

```txt
ARTIFACT_STORAGE_PROVIDER=s3
ARTIFACT_STORAGE_S3_ENDPOINT=http://seaweedfs:8333
ARTIFACT_STORAGE_S3_BUCKET=deputies-artifacts
ARTIFACT_STORAGE_S3_ACCESS_KEY_ID=seaweed
ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY=seaweed
ARTIFACT_STORAGE_S3_CREATE_BUCKET=true
```

## Migrations

Migrations run through the one-shot `control-plane-migrate` service before the API starts.

Run migrations manually:

```sh
docker compose -f deploy/docker-compose/docker-compose.combined.yml run --rm control-plane-migrate
```

View service status, including the migration exit code:

```sh
docker compose -f deploy/docker-compose/docker-compose.combined.yml ps -a
```

## Codex Auth

Compose bind mounts the host Codex auth file into containers that run workers:

```yaml
${HOME}/.pi/agent/auth.json:/run/secrets/openai-codex-auth.json
```

If you use `RUNNER_MODEL_DEFAULT=openai-codex/<model>`, create the host auth file first:

```sh
mise run //apps/control-plane:auth:login:openai-codex
```

The Compose files set `OPENAI_CODEX_AUTH_FILE=/run/secrets/openai-codex-auth.json` for worker-capable containers.

## Docker Sandbox Provider

Both variants support `SANDBOX_PROVIDER=docker`. Prefer the published GHCR image:

```sh
DOCKER_SANDBOX_IMAGE=ghcr.io/sidpalas/deputies-docker-sandbox:latest
```

Build a local image only when testing sandbox image changes.

The combined variant mounts `/var/run/docker.sock` into `control-plane` and uses `DOCKER_ORCHESTRATOR_MODE=in-process`.

The split variant mounts `/var/run/docker.sock` only into `docker-orchestrator`; `api` and `worker` call it over HTTP using `DOCKER_ORCHESTRATOR_MODE=http`.

## Logs

Combined stack:

```sh
docker compose -f deploy/docker-compose/docker-compose.combined.yml logs -f
```

Combined control plane only:

```sh
docker compose -f deploy/docker-compose/docker-compose.combined.yml logs -f control-plane
```

Split API and worker:

```sh
docker compose -f deploy/docker-compose/docker-compose.split.yml logs -f api worker docker-orchestrator
```

## Stop Or Reset

Stop containers while keeping volumes:

```sh
docker compose -f deploy/docker-compose/docker-compose.combined.yml down
```

Reset local volumes too:

```sh
docker compose -f deploy/docker-compose/docker-compose.combined.yml down -v
```
