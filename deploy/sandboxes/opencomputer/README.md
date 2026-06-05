# OpenComputer Sandbox Snapshot

This directory documents the OpenComputer provider snapshot used by Deputies sandboxes. OpenComputer snapshots are built with the OpenComputer SDK rather than Docker, so the build script installs the sandbox toolchain directly into an OpenComputer image manifest.

## Current Status

As of 2026-06-05, OpenComputer snapshot creation is validated end-to-end for the `minimal` and `bridge` variants. The `minimal` variant has zero image steps and proves API auth, 1Password env resolution, SSE parsing, snapshot creation, checkpointing, and cache-hit snapshot naming all work. The `bridge` variant adds only the Deputies sandbox bridge payload and bridge environment, then successfully creates a ready snapshot.

The `slim` and `full` variants currently fail against OpenComputer before they produce build logs. The latest `slim` attempts return Cloudflare `524` from `POST /api/snapshots`; polling the snapshot name afterward still returns `404`, so no named ready snapshot is produced. Earlier attempts also saw `timed out waiting for image build (hash=...)`, which maps to OpenComputer waiting on an existing `building` image-cache row for the same manifest hash.

The `bridge` variant is a smaller diagnostic/runtime candidate that only adds the Deputies sandbox bridge files and bridge environment to the base image. It does not install Node, Postgres, mise, hunkdiff, code-server, Playwright, or common CLI tools. It is small enough for OpenComputer snapshot creation. A sandbox created from `deputies-opencomputer-base-bridge` had `/usr/bin/node` version `v20.20.2`, and `node --check /opt/deputies/sandbox-bridge/dist/server.js` passed.

What has been tried:

- `minimal` with the TypeScript snapshot script succeeded: `deputies-opencomputer-base-minimal`, status `ready`.
- A temporary Python SDK path was tried because its client uses `httpx.AsyncClient.stream()`; `minimal` succeeded there too, but `slim` still returned `524`, so the Python implementation was removed.
- `bridge` with the TypeScript snapshot script succeeded: `deputies-opencomputer-base-bridge`, status `ready`, snapshot ID `5b97786d-2263-42fc-bdbd-cfbb225c9acd`, checkpoint ID `7b543629-2c2d-452a-ad60-1b37c0a03d95`. A sandbox created from it had Node `v20.20.2` available and passed a syntax check of the bridge server.
- `slim` skips Playwright and code-server but still includes Node 24, Postgres 16, mise, hunkdiff, common CLI tools, and the Deputies sandbox bridge.
- The TypeScript script now uses explicit SSE snapshot creation and suppresses large Cloudflare HTML responses.
- `--revision <value>` was added to force a new OpenComputer image-cache hash and avoid stale `building` rows; this changed the hash but did not make `slim` complete.
- Post-`524` polling was added because OpenComputer may continue background work after Cloudflare closes the client connection; no `slim` snapshot appeared during polling.

The remaining issue appears to be server-side in OpenComputer's deployed snapshot builder or edge path, not local auth or local script behavior. The snapshot API only accepts `{ name, image }`, so this repo cannot currently request more build-sandbox memory or a longer build timeout. In the upstream OpenComputer code, snapshot builds create a throwaway build sandbox with `Timeout: 600` and no explicit `MemoryMB`; increasing those server-side defaults may be required before `slim` or `full` can complete.

## Included Tooling

The full variant includes:

- Node.js 24 and Corepack/pnpm
- Playwright Chromium and Linux browser dependencies
- Postgres 16 and PostgreSQL client tools
- code-server, ttyd, mise, and hunkdiff
- Deputies sandbox bridge at `/opt/deputies/sandbox-bridge`
- Git, Git LFS, SSH, fd, ripgrep, jq, rsync, vim, and zsh
- A writable `/workspace` with `DEPUTIES_WORKSPACE=/workspace`

The slim variant skips Playwright and code-server to keep snapshot creation smaller and faster. It still includes Node.js 24, Postgres 16, ttyd, mise, hunkdiff, the Deputies sandbox bridge, and common CLI tooling.

The bridge variant only adds the Deputies sandbox bridge files, bridge environment variables, and `/workspace` workdir to the base OpenComputer image. It relies on Node from the base OpenComputer image; the current base provides `/usr/bin/node` `v20.20.2`.

The minimal variant has zero image steps. It does not install the Deputies sandbox bridge and is only useful for validating OpenComputer snapshot creation end-to-end.

The `fd` binary is installed from Debian's `fd-find` package and symlinked to `/usr/local/bin/fd`.

OpenComputer provider previews expose only the sandbox bridge port through OpenComputer. Deputies appends `/preview/<service-port>` and sends a bridge bearer token, so browser-facing services receive Deputies preview host headers rather than raw OpenComputer hostnames.

## Create Snapshot

Set `OPENCOMPUTER_API_KEY`, then run the default bridge snapshot from anywhere in the repo:

```sh
mise run //deploy/sandboxes/opencomputer:snapshot:create
```

If `.env.local` stores `OPENCOMPUTER_API_KEY` as a 1Password reference such as `op://...`, resolve it through the 1Password CLI:

```sh
op run --env-file .env.local -- mise run //deploy/sandboxes/opencomputer:snapshot:create
```

For the larger full snapshot with Playwright and code-server:

```sh
mise run //deploy/sandboxes/opencomputer:snapshot:create:full
```

For the smaller experimental snapshot that skips Playwright and code-server:

```sh
mise run //deploy/sandboxes/opencomputer:snapshot:create:slim
```

With 1Password references:

```sh
op run --env-file .env.local -- mise run //deploy/sandboxes/opencomputer:snapshot:create:slim
```

The explicit bridge-only task is equivalent to the default `snapshot:create` task:

```sh
op run --env-file .env.local -- mise run //deploy/sandboxes/opencomputer:snapshot:create:bridge
```

For a provider-only smoke test with no image install steps:

```sh
op run --env-file .env.local -- mise run //deploy/sandboxes/opencomputer:snapshot:create:minimal
```

Useful options can be passed after `--`:

```sh
mise run //deploy/sandboxes/opencomputer:snapshot:create:full -- --name deputies-opencomputer-node24-pg16-playwright1-59-1
mise run //deploy/sandboxes/opencomputer:snapshot:create -- --variant slim
mise run //deploy/sandboxes/opencomputer:snapshot:create:slim -- --revision retry-1
mise run //deploy/sandboxes/opencomputer:snapshot:create -- --dry-run
```

The snapshot name defaults to `OPENCOMPUTER_SNAPSHOT_NAME`, then `OPENCOMPUTER_SNAPSHOT`, then the variant default. The full default is `deputies-opencomputer-node24-pg16-playwright1-59-1`; the slim default is `deputies-opencomputer-node24-pg16-slim`; the bridge default is `deputies-opencomputer-base-bridge`; the minimal default is `deputies-opencomputer-base-minimal`.

## Deputies Configuration

Configure new OpenComputer sandboxes to use the generated bridge snapshot:

```sh
SANDBOX_PROVIDER=opencomputer
OPENCOMPUTER_SNAPSHOT=deputies-opencomputer-base-bridge
```

For the slim variant:

```sh
OPENCOMPUTER_SNAPSHOT=deputies-opencomputer-node24-pg16-slim
```

For the bridge-only variant:

```sh
OPENCOMPUTER_SNAPSHOT=deputies-opencomputer-base-bridge
```

Do not configure Deputies with the minimal variant unless you only need to test provider create/connect basics. It does not include the sandbox bridge or Deputies runtime tooling.

Keep the existing OpenComputer settings as needed:

```sh
OPENCOMPUTER_API_KEY=<secret>
OPENCOMPUTER_API_URL=<optional>
OPENCOMPUTER_SECRET_STORE=<optional>
```

Postgres-backed tests inside an OpenComputer sandbox can use the same direct-Postgres helper path as Daytona after the repository is present:

```sh
./deploy/sandboxes/daytona/start-postgres.sh
```

## Kill Sandbox

The OpenComputer CLI is managed by mise from the official GitHub release binary. Kill one or more OpenComputer sandboxes by ID:

```sh
op run --env-file .env.local -- mise run //deploy/sandboxes/opencomputer:sandbox:kill -- sb-12345678
op run --env-file .env.local -- mise run //deploy/sandboxes/opencomputer:sandbox:kill -- sb-12345678 sb-abcdef12
```

## Troubleshooting

If snapshot creation fails with Cloudflare `524`, the OpenComputer snapshot build endpoint timed out before returning the final snapshot result. The script polls for the named snapshot after this timeout because the provider build may continue after Cloudflare closes the client connection. If the snapshot still does not appear, retry the slim variant first:

```sh
mise run //deploy/sandboxes/opencomputer:snapshot:create:slim
```

The script can still validate the image manifest locally with `--dry-run`, but the named snapshot is only usable after the script prints `Configure Deputies with OPENCOMPUTER_SNAPSHOT=...`.

If OpenComputer reports `timed out waiting for image build`, it may be waiting on a stale in-flight image cache row for the same manifest hash. Use `--revision <value>` to add a harmless image env marker and force a new OpenComputer image cache hash.
