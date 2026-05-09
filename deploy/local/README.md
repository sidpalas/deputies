# Local Docker Compose

This Compose stack runs the production-style containers locally:

- `postgres`: local Postgres database
- `api-migrate`: one-shot database migration job
- `api`: compiled API and worker process
- `web`: built Vite app served by nginx

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

The services are available at:

- Web: `http://localhost:5173`
- API: `http://localhost:3583`
- Postgres: `localhost:5432`

Check API health:

```sh
curl http://localhost:3583/health
```

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

Migrations run through the one-shot `api-migrate` service before `api` starts.

Run migrations manually:

```sh
docker compose -f deploy/local/docker-compose.yml run --rm api-migrate
```

View service status, including the migration exit code:

```sh
docker compose -f deploy/local/docker-compose.yml ps -a
```

## Codex Auth

Compose bind mounts the host Codex auth file into the API container:

```yaml
${HOME}/.pi/agent/auth.json:/run/secrets/openai-codex-auth.json
```

If you use `FLUE_MODEL=openai-codex/<model>`, create the host auth file first:

```sh
pnpm --dir apps/api auth:login:openai-codex
```

The Compose file sets `FLUE_OPENAI_CODEX_AUTH_FILE=/run/secrets/openai-codex-auth.json` for the API container.

## Logs

All services:

```sh
docker compose -f deploy/local/docker-compose.yml logs -f
```

API only:

```sh
docker compose -f deploy/local/docker-compose.yml logs -f api
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
