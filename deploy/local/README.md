# Local Docker Compose

These Compose stacks run the production-style containers locally. Both variants include these common services:

- `postgres`: local Postgres database
- `seaweedfs`: local S3-compatible object storage for stored artifacts
- `control-plane-migrate`: one-shot database migration job
- `web`: built Vite app served by Caddy, with API routes proxied to the API service

The all-in-one variant also runs:

- `control-plane`: compiled API and worker process, with Docker orchestration in-process

The split variant also runs:

- `api`: API-only control-plane process
- `worker`: worker-only control-plane process
- `docker-orchestrator`: Docker sandbox orchestration service with Docker daemon access

## Prerequisites

- Docker Desktop or compatible Docker engine
- `.env.local` in the repository root
- Optional Codex subscription auth at `~/.pi/agent/auth.json`

Copy `.env.example` to `.env.local` if you do not already have local settings:

```sh
cp .env.example .env.local
```

## Start The Stack

From the repository root:

```sh
docker compose -f deploy/local/docker-compose.yml up -d --build
```

`deploy/local/docker-compose.yml` defaults to the all-in-one variant. You can also run it explicitly:

```sh
docker compose -f deploy/local/docker-compose.all.yml up -d --build
```

Run the split API/worker/orchestrator variant with:

```sh
docker compose -f deploy/local/docker-compose.split.yml up -d --build
```

The split stack starts two worker replicas by default. Override that count with:

```sh
docker compose -f deploy/local/docker-compose.split.yml up -d --scale worker=4
```

The services are available at:

- Web: `http://localhost:5173`
- API direct: `http://localhost:3583`
- Postgres: `localhost:5432`
- SeaweedFS S3 API: `http://localhost:8333`

Check proxied API health:

```sh
curl http://localhost:5173/health
```

## Artifact Storage

The local Compose stacks enable stored artifacts by default with SeaweedFS' S3-compatible API.
The SeaweedFS container enables S3 authentication with `AWS_ACCESS_KEY_ID=seaweed` and `AWS_SECRET_ACCESS_KEY=seaweed`:

```txt
ARTIFACT_STORAGE_PROVIDER=s3
ARTIFACT_STORAGE_S3_ENDPOINT=http://seaweedfs:8333
ARTIFACT_STORAGE_S3_BUCKET=deputies-artifacts
ARTIFACT_STORAGE_S3_ACCESS_KEY_ID=seaweed
ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY=seaweed
ARTIFACT_STORAGE_S3_CREATE_BUCKET=true
```

Agents can publish sandbox files through the Flue `artifact({ action: "create" })` tool. Stored artifacts appear in the session UI, use authenticated product API download URLs, and support text previews for text-like files.

For no-service local development outside Compose, use the filesystem adapter instead:

```sh
ARTIFACT_STORAGE_PROVIDER=filesystem
ARTIFACT_STORAGE_FILESYSTEM_PATH=.artifacts
```

Filesystem storage is intended for local/single-process use only. Production-like deployments should use S3-compatible storage.

## Restart

Restart without rebuilding:

```sh
docker compose -f deploy/local/docker-compose.yml up -d
```

Rebuild after Dockerfile or dependency changes:

```sh
docker compose -f deploy/local/docker-compose.yml up -d --build
```

## Migrations

Migrations run through the one-shot `control-plane-migrate` service before the API starts.

Run migrations manually:

```sh
docker compose -f deploy/local/docker-compose.yml run --rm control-plane-migrate
```

View service status, including the migration exit code:

```sh
docker compose -f deploy/local/docker-compose.yml ps -a
```

## Codex Auth

Compose bind mounts the host Codex auth file into containers that run workers:

```yaml
${HOME}/.pi/agent/auth.json:/run/secrets/openai-codex-auth.json
```

If you use `FLUE_MODEL=openai-codex/<model>`, create the host auth file first:

```sh
pnpm --dir apps/control-plane auth:login:openai-codex
```

The Compose files set `FLUE_OPENAI_CODEX_AUTH_FILE=/run/secrets/openai-codex-auth.json` for worker-capable containers.

## Docker Sandbox Provider

Both variants support `SANDBOX_PROVIDER=docker` when the sandbox image exists locally:

```sh
docker build -f deploy/docker/Dockerfile -t deputies-sandbox:local .
```

The all-in-one variant mounts `/var/run/docker.sock` into `control-plane` and uses `DOCKER_ORCHESTRATOR_MODE=in-process`.

The split variant mounts `/var/run/docker.sock` only into `docker-orchestrator`; `api` and `worker` call it over HTTP using `DOCKER_ORCHESTRATOR_MODE=http`.

## Logs

All services:

```sh
docker compose -f deploy/local/docker-compose.yml logs -f
```

All-in-one control plane only:

```sh
docker compose -f deploy/local/docker-compose.yml logs -f control-plane
```

Split API and worker:

```sh
docker compose -f deploy/local/docker-compose.split.yml logs -f api worker docker-orchestrator
```

## Stop Or Reset

Stop containers while keeping the Postgres volume:

```sh
docker compose -f deploy/local/docker-compose.yml down
```

Reset the local database too:

```sh
docker compose -f deploy/local/docker-compose.yml down -v
```
