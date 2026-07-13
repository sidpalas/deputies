# Daytona Sandbox Image

This directory defines the Daytona provider image and helper scripts for running Deputies work in a sandbox with enough local tooling to run the API, web app, browser tests, and Postgres-backed integration tests.

## Why Postgres Runs Directly

Daytona can create sandboxes from OCI/container images, but that does not imply nested Docker or Docker Compose is available inside every sandbox target. For reliable coverage across Daytona targets, this image installs Postgres directly in the sandbox and starts it with `pg_ctl`.

If your Daytona target supports privileged Docker, `deploy/local/docker-compose.yml` can still be used manually. The default sandbox path should not depend on nested containers.

## Included Tooling

- Shared Deputies sandbox base image
- Node.js 24 and Corepack/pnpm
- Playwright Chromium and Linux browser dependencies installed explicitly
- Postgres and PostgreSQL client tools installed explicitly
- Git, Git LFS, SSH, jq, rsync, and zsh

The Daytona and Docker provider images build on the same base and differ primarily by entrypoint/runtime contract. Daytona keeps the container alive with `sleep infinity` because Daytona supplies exec/filesystem APIs outside the container.

## Published Image

Use the published GHCR image for normal Daytona sandboxes:

```sh
DAYTONA_IMAGE=ghcr.io/sidpalas/deputies-daytona-sandbox:latest
```

Use a pinned tag or digest for repeatable deployments.

## Build And Publish

Build from the repository root only when changing this image or publishing a fork:

```sh
docker buildx build --platform linux/amd64 --provenance=false --sbom=false -f deploy/sandboxes/base/Dockerfile -t deputies-sandbox-base:local --load .
docker buildx build --platform linux/amd64 --provenance=false --sbom=false -f deploy/sandboxes/daytona/Dockerfile -t ghcr.io/<owner>/deputies-daytona-sandbox:ubuntu24-node24-pg16-playwright1.59.1 --push .
```

Or use mise:

```sh
mise run //deploy/sandboxes/daytona:image:publish
```

Daytona currently pulls `linux/amd64` images. If you build on Apple Silicon without `--platform linux/amd64`, GHCR may publish an ARM-only manifest and Daytona will fail with `no match for platform in manifest`. The publish command also disables SBOM/provenance attestations so GHCR does not add extra `unknown/unknown` package entries that can confuse strict image resolvers.

To publish the `latest` tag explicitly:

```sh
DAYTONA_IMAGE=ghcr.io/<owner>/deputies-daytona-sandbox:latest mise run //deploy/sandboxes/daytona:image:publish
```

Use any registry Daytona can pull from. For private registries, configure registry credentials in Daytona before using the image.

Daytona recommends images use a specific tag or digest, not `latest`, `lts`, or `stable`. Snapshots also require a long-running entrypoint; this image explicitly uses `sleep infinity`, which matches Daytona's default behavior when no entrypoint is provided.

## GHCR Private Package Access

If the image is private in GitHub Container Registry, Daytona needs credentials that can pull it:

```text
Registry: ghcr.io
Username: <github-user-or-org-user>
Password: <personal-access-token-with-read:packages>
```

For GHCR, also link the container package to the corresponding GitHub repository when the package is private and not already repository-linked. In GitHub, open the package settings and connect it to your fork/repository. This makes package permissions line up with repository access and avoids confusing `denied` or `not found` pull failures even when the PAT has `read:packages`.

If you publish under a different owner, link that package to the repo that owns the image source and make sure the PAT user has access to both the repo and package.

## Deputies Configuration

Set the control-plane service environment so new agent sandboxes use this image:

```sh
SANDBOX_PROVIDER=daytona
DAYTONA_IMAGE=ghcr.io/sidpalas/deputies-daytona-sandbox:latest
```

Keep the existing Daytona settings as needed:

```sh
DAYTONA_API_KEY=<secret>
DAYTONA_API_URL=<optional>
DAYTONA_TARGET=<optional>
```

Recommended Daytona sandbox resources for full test runs:

```text
CPU: 2+
Memory: 4 GiB+
Disk: 8-10 GiB
```

Request those resources from Deputies with deployment-level settings:

```sh
DAYTONA_SANDBOX_CPU=2
DAYTONA_SANDBOX_MEMORY_GIB=4
DAYTONA_SANDBOX_DISK_GIB=10
```

Leave them empty to use Daytona defaults. GPU is also available as `DAYTONA_SANDBOX_GPU` when needed.

## Full Sandbox Check

Inside a Daytona sandbox after the repository is present:

```sh
./deploy/sandboxes/daytona/full-check.sh
```

The script:

1. Starts local Postgres inside the sandbox.
2. Creates `deputies` and `deputies_test` databases if needed.
3. Installs pnpm dependencies.
4. Runs migrations.
5. Runs API typecheck, unit tests, and integration tests.
6. Runs web typecheck, unit tests, Playwright e2e tests, and production build.

Remove `$HOME/.deputies/postgres` before restarting if the cluster was initialized with older `flue` database defaults.

It sets these defaults when not already provided:

```sh
DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies
TEST_DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies_test
API_AUTH_MODE=none
```

UAT tests that require external credentials remain opt-in. For example, `apps/control-plane/test/uat/real-daytona-pi.test.ts` only runs when `RUN_REAL_DAYTONA_PI_UAT=true` and the required Daytona/model/database env vars are set.

## Start Only Postgres

For manual development inside a sandbox:

```sh
./deploy/sandboxes/daytona/start-postgres.sh
```

Then run services directly:

```sh
DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies mise run //apps/control-plane:db:migrate
DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies API_AUTH_MODE=none mise run //apps/control-plane:dev
VITE_API_PROXY_TARGET=http://127.0.0.1:3583 mise run //apps/web:dev
```
