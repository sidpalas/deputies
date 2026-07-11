# OpenComputer Sandbox Snapshots

Deputies uses an OpenComputer snapshot containing the sandbox bridge. Snapshots are built from an OpenComputer `Image` manifest rather than a Dockerfile.

## Prerequisites

- Install repository dependencies with `mise install` and `pnpm install`.
- Set `OPENCOMPUTER_API_KEY`.
- If the API key is a 1Password reference, run tasks through `op run --env-file=.env.local --`.

The OpenComputer CLI version is managed by this directory's `mise.toml`.

## Create A Snapshot

The default task creates the recommended bridge-only snapshot:

```sh
op run --env-file=.env.local -- mise run //deploy/sandboxes/opencomputer:snapshot:create
```

The equivalent explicit task is:

```sh
op run --env-file=.env.local -- mise run //deploy/sandboxes/opencomputer:snapshot:create:bridge
```

The bridge snapshot includes:

- `/opt/deputies/sandbox-bridge/dist`
- `/opt/deputies/ensure-sandbox-bridge.sh`
- A `/workspace` working directory
- Bridge environment defaults for port `3584`

Generated snapshot names include a UTC timestamp so repeated builds do not collide. Set `OPENCOMPUTER_SNAPSHOT_NAME` or pass `--name` only when a fixed unique name is required:

```sh
mise run //deploy/sandboxes/opencomputer:snapshot:create -- --name deputies-opencomputer-custom
```

Inspect the image manifest without creating remote resources:

```sh
mise run //deploy/sandboxes/opencomputer:snapshot:create -- --dry-run
```

The script prints the exact runtime setting after a successful build:

```text
Configure Deputies with OPENCOMPUTER_SNAPSHOT=<snapshot-name>
```

## Optional Variants

The bridge variant is preferred for normal provider operation. Larger variants are available when the sandbox must include additional development tools:

```sh
mise run //deploy/sandboxes/opencomputer:snapshot:create:slim
mise run //deploy/sandboxes/opencomputer:snapshot:create:full
```

- `slim` adds Node.js 24, PostgreSQL 16, mise, hunkdiff, ttyd, and common CLI tools.
- `full` additionally installs Playwright Chromium and code-server.
- `minimal` contains no Deputies bridge and is only an OpenComputer snapshot API smoke test.

OpenComputer controls build-sandbox disk capacity. Prefer the bridge variant unless the larger toolchain is required.

## Configure Deputies

Configure the provider with the snapshot name printed by the build:

```sh
SANDBOX_PROVIDER=opencomputer
OPENCOMPUTER_API_KEY=<secret>
OPENCOMPUTER_SNAPSHOT=<snapshot-name>
```

When `APP_DATA_STORE=postgres`, also configure `SANDBOX_SECRET_ENCRYPTION_KEY` so Deputies can persist encrypted bridge credentials.

Optional settings:

```sh
OPENCOMPUTER_API_URL=
OPENCOMPUTER_SECRET_STORE=
OPENCOMPUTER_CPU_COUNT=
OPENCOMPUTER_MEMORY_MB=
OPENCOMPUTER_DISK_MB=
```

## Run The Live UAT

The live UAT creates a real sandbox, exercises exec and filesystem operations, verifies a bridged service endpoint, hibernates and wakes the sandbox, reconnects, and destroys it during cleanup:

```sh
op run --env-file=.env.local -- mise run //deploy/sandboxes/opencomputer:uat
```

The task requires `OPENCOMPUTER_API_KEY` and `OPENCOMPUTER_SNAPSHOT`.

## Kill Sandboxes

Kill one or more sandboxes by provider ID:

```sh
op run --env-file=.env.local -- mise run //deploy/sandboxes/opencomputer:sandbox:kill -- sb-12345678
```
