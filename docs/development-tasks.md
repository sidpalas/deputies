# Development Tasks

Deputies uses both `package.json` scripts and `mise` tasks. Keep each task in the smallest place that owns the command.

## `package.json` Scripts

Use package scripts for JavaScript package lifecycle commands that developers, CI, editors, or package tooling commonly expect to run with `pnpm`:

- `dev`, `start`, `build`, `preview`
- `typecheck`
- `test`, `test:watch`, package-specific test variants
- package-local code generation or one-off scripts that run through Node tooling

Put package-local scripts in that package's `package.json`. Add a root script only when it is a stable repo-level entrypoint, such as `pnpm check`, `pnpm typecheck`, or a documented compatibility shortcut.

## `mise` Tasks

Use `mise` for commands that are workflow, infrastructure, deployment, or environment oriented rather than package lifecycle oriented:

- installing the pinned toolchain and project dependencies
- local infrastructure such as Postgres, SeaweedFS, or Portless
- Docker, Kubernetes, Railway, and sandbox-image workflows
- searchable wrappers for standard package lifecycle commands
- repo-level aggregators that compose package scripts
- discoverability helpers such as `mise-fzf`

Place each `mise.toml` next to the config or scripts it operates on. Examples:

- Root `mise.toml`: tool versions, `install`, `check`, `test`, `typecheck`, formatting, and task discovery.
- `apps/*/mise.toml` and `packages/*/mise.toml`: searchable wrappers for standard lifecycle scripts such as `dev`, `build`, `test`, and `typecheck`.
- `deploy/local/mise.toml`: local Docker Compose and Portless tasks.
- `deploy/kubernetes/mise.toml`: Helm, kind, and Kubernetes smoke workflows.
- `deploy/sandboxes/daytona/mise.toml`: Daytona sandbox image tasks.
- `deploy/sandboxes/superserve/mise.toml`: Superserve template synchronization and live-UAT tasks.
- `deploy/railway/mise.toml`: Railway service deploy tasks.

## Both

Avoid mirroring every package-specific script into `mise`. Define both when the `mise` task adds meaningful value, such as making standard lifecycle commands searchable with `mise task ls --all`, composing multiple package scripts, or setting workflow-specific environment variables.

If a task is a standard lifecycle command like `dev`, `build`, `test`, `typecheck`, `preview`, or `e2e`, it can be wrapped in that package's `mise.toml` for discovery. If it replaces a removed root alias or is a meaningful developer workflow, expose it through the nearest `mise.toml` instead of re-adding a root alias.
