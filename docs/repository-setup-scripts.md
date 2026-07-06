# Repository Setup Scripts

Repository owners can commit `.agents/setup` at the repository root to prepare a sandbox before an agent starts work. Use it for repeatable project setup that every Deputies session needs, such as installing dependencies, starting local services, seeding fixtures, or writing local-only config files.

## Convention

- Location: `.agents/setup`, a single regular file tracked by Git at the repository root.
- Execution: executable files run as `./.agents/setup`; non-executable files run as `bash .agents/setup`.
- Ignored paths: untracked files, directories, and symlinks at `.agents/setup` are treated as absent.
- Working directory: the prepared repository workspace, such as `/workspace/<owner>/<repo>`.
- Environment: the sandbox's normal environment plus `DEPUTIES=1` and `DEPUTIES_SETUP=1`.
- Credentials: Deputies does not pass the temporary `GITHUB_AUTH_HEADER` used for clone/fetch into the script.
- Interactivity: scripts run without a TTY or stdin. They must not prompt.
- Timeout: `REPOSITORY_SETUP_SCRIPT_TIMEOUT_SECONDS`, default `600` seconds.

The script runs with whatever credentials are already available to the agent in the sandbox, such as installed CLIs or mounted auth. Treat it like any other repository-controlled code an agent can run inside the sandbox. Under the current trust model, Deputies prepares trusted, allowlisted repositories only; repository code and dependencies can observe short-lived, repo-scoped credentials used later by sandbox-backed `git` or `gh` operations.

## Idempotency

Deputies runs `.agents/setup` once per clone and reruns it only when the script changes.

After a successful run, Deputies writes the script's git blob hash to `.git/deputies-setup-hash`. The stamp lives under `.git/`, so it does not dirty the working tree and disappears with the clone.

The script runs when the repository was freshly cloned, the stamp is missing, or the current `.agents/setup` hash differs from the stamped hash. Make scripts safe to rerun because branch switches and script edits can trigger another run.

## Failure Behavior

Setup script failures are non-fatal. Deputies continues the run, emits `setup_script_started` and `setup_script_finished` events, and tells the agent about the failure so it can remediate or work around it.

If Deputies cannot inspect whether `.agents/setup` should run, it emits `setup_script_finished` with `phase: "probe"` and tells the agent about the probe failure. `setup_script_finished` stores only the last 8 KiB of stdout and stderr. Do not print secrets.

Operators can disable the feature globally:

```sh
REPOSITORY_SETUP_SCRIPT_ENABLED=false
```

## Examples

Install JavaScript dependencies:

```bash
#!/usr/bin/env bash
set -euo pipefail
corepack enable
pnpm install --frozen-lockfile
```

Start a local Postgres helper and run migrations:

```bash
#!/usr/bin/env bash
set -euo pipefail
./deploy/sandboxes/daytona/start-postgres.sh
export DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies
export TEST_DATABASE_URL=postgres://deputies:deputies@127.0.0.1:5432/deputies_test
mise run //apps/control-plane:db:migrate
```

Seed local config without overwriting user edits:

```bash
#!/usr/bin/env bash
set -euo pipefail
if [ ! -f .env.local ]; then
  cp .env.example .env.local
fi
```

Heavy setup can hit memory or CPU limits on smaller sandbox providers. Prefer cached package managers and idempotent checks before expensive work.

When starting long-lived background services, detach their standard streams so the setup command can finish:

```bash
nohup pnpm dev >/tmp/my-app.log 2>&1 </dev/null &
```

Avoid a plain `server &` when the server inherits stdout or stderr; some sandbox providers wait for those streams to close and the setup command can hang until the timeout.
