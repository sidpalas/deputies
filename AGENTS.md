# Agent Instructions

## Local Dependencies

Use the repo toolchain from `mise.toml`:

```sh
mise install
pnpm install
```

## Postgres In Sandboxes Without Nested Virtualization

Some sandbox providers do not support nested Docker or Docker Compose. For Postgres-backed tests in any sandbox without nested virtualization, start Postgres directly inside the sandbox:

```sh
./deploy/sandboxes/daytona/start-postgres.sh
```

This creates and starts a local Postgres cluster and ensures these databases exist:

```text
flue
flue_test
```

Use these connection strings unless the task provides different ones:

```sh
export DATABASE_URL=postgres://flue:flue@127.0.0.1:5432/flue
export TEST_DATABASE_URL=postgres://flue:flue@127.0.0.1:5432/flue_test
```

Run migrations before API integration or UAT checks:

```sh
pnpm control-plane:db:migrate
```

## Full Sandbox Verification

For broad coverage inside a sandbox image that includes the Daytona verification scripts, run:

```sh
./deploy/sandboxes/daytona/full-check.sh
```

This starts Postgres, installs dependencies, runs migrations, then runs API typecheck/unit/integration tests and web typecheck/unit/e2e/build checks.

## Common Test Commands

```sh
pnpm control-plane:typecheck
pnpm control-plane:test
pnpm control-plane:test:integration
pnpm web:typecheck
pnpm web:test
pnpm web:e2e
pnpm web:build
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
