# Agent Instructions

## Local Dependencies

Use the repo toolchain from `mise.toml`:

```sh
mise install
pnpm install
```

## Postgres In Daytona Sandboxes

Daytona sandboxes should not assume nested Docker or Docker Compose is available. For Postgres-backed tests, start Postgres directly inside the sandbox:

```sh
./deploy/daytona/start-postgres.sh
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

For broad coverage inside a Daytona sandbox, run:

```sh
./deploy/daytona/full-check.sh
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

Do not claim Postgres-backed tests could not run until you have tried `./deploy/daytona/start-postgres.sh` or confirmed the sandbox is not using the Daytona image from `deploy/daytona/Dockerfile`.

## Commits

Commit messages should follow Conventional Commits style.
