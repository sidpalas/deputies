# Local Support Services

This directory contains contributor-focused local infrastructure used by local mise tasks.

It does not deploy the full Deputies application stack. Full Docker Compose app deployments live in `../docker-compose/`.

The normal contributor baseline is both Postgres and SeaweedFS:

```sh
mise run //deploy/local:infra:up
```

## Services

- `postgres`: local Postgres database with `flue` and `flue_test` databases.
- `seaweedfs`: local S3-compatible object storage for artifact testing.

## Commands

From the repository root:

```sh
mise run //deploy/local:infra:up
mise run //deploy/local:infra:down
```

`mise run //deploy/local:infra:up` starts the normal local baseline, including Postgres and SeaweedFS artifact storage.

Equivalent Docker Compose commands:

```sh
docker compose -f deploy/local/docker-compose.yml up -d postgres seaweedfs
docker compose -f deploy/local/docker-compose.yml down
```

Reset local volumes:

```sh
docker compose -f deploy/local/docker-compose.yml down -v
```

Default local connection strings:

```sh
DATABASE_URL=postgres://flue:flue@localhost:5432/flue
TEST_DATABASE_URL=postgres://flue:flue@localhost:5432/flue_test
```

Default local S3-compatible artifact settings:

```sh
ARTIFACT_STORAGE_PROVIDER=s3
ARTIFACT_STORAGE_S3_ENDPOINT=http://localhost:8333
ARTIFACT_STORAGE_S3_BUCKET=deputies-artifacts
ARTIFACT_STORAGE_S3_ACCESS_KEY_ID=seaweed
ARTIFACT_STORAGE_S3_SECRET_ACCESS_KEY=seaweed
```
