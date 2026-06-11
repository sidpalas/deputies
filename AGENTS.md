# Agent Instructions

## Local Dependencies

Use the repo toolchain from `mise.toml`:

```sh
mise install
pnpm install
```

If `mise` reports that repo config files are not trusted, inspect the repo-local `mise.toml` files before trusting them. For this repo, trust the checked-in configs when they are needed:

```sh
mise trust
```

Do not blindly trust `mise` configs from unrelated or unreviewed repositories.

Discover repo tasks with:

```sh
mise task ls --all
```

Prefer discovered `mise run //path:task` commands for repo workflows. Use direct `pnpm --dir <package> <script>` commands only when no matching `mise` task exists.

## Postgres In Sandboxes Without Nested Virtualization

Some sandbox providers do not support nested Docker or Docker Compose. For Postgres-backed tests in any sandbox without nested virtualization, start Postgres directly inside the sandbox:

```sh
./deploy/sandboxes/daytona/start-postgres.sh
```

This creates and starts a local Postgres cluster and ensures these databases exist:

```text
deputies
deputies_test
```

Use these connection strings unless the task provides different ones:

```sh
export DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies
export TEST_DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies_test
```

For local Docker-based development outside a sandbox, you can also start the test database with:

```sh
mise run //deploy/local:infra:up
```

That starts the local Postgres service used by the repo and creates the `deputies_test` database for integration tests.

Run migrations before API integration or UAT checks:

```sh
mise run //apps/control-plane:db:migrate
```

## Full Sandbox Verification

For broad coverage inside a sandbox image that includes the Daytona verification scripts, run:

```sh
./deploy/sandboxes/daytona/full-check.sh
```

This starts Postgres, installs dependencies, runs migrations, then runs API typecheck/unit/integration tests and web typecheck/unit/e2e/build checks.

## Common Test Commands

```sh
mise run //apps/control-plane:typecheck
mise run //apps/control-plane:test
mise run //apps/control-plane:test:integration
mise run //apps/web:typecheck
mise run //apps/web:test
mise run //apps/web:e2e
mise run //apps/web:build
```

## Web API Routes

When adding or changing browser-facing API routes, keep all local and deployed web proxies in sync:

- `apps/web/vite.config.ts` for Vite dev proxy routes.
- `apps/web/Caddyfile` for deployed/static web reverse proxy routes.
- `apps/web/Caddyfile.local` for local Caddy/portless reverse proxy routes.

If a route works in Vite dev but fails after deployment, check these Caddy matchers first.

Do not claim Postgres-backed tests could not run until you have tried `./deploy/sandboxes/daytona/start-postgres.sh` or confirmed the current sandbox image does not include the direct-Postgres helper scripts from `deploy/sandboxes/daytona/`.

## Commits

Commit messages should follow Conventional Commits style.
