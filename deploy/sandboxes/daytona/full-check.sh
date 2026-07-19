#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

./deploy/sandboxes/daytona/start-postgres.sh

export DATABASE_URL=${DATABASE_URL:-postgres://deputies:deputies@127.0.0.1:5432/deputies}
export TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgres://deputies:deputies@127.0.0.1:5432/deputies_test}
export API_AUTH_MODE=${API_AUTH_MODE:-none}

pnpm install --frozen-lockfile
pnpm --dir apps/control-plane db:migrate

pnpm --dir apps/control-plane typecheck
pnpm --dir apps/control-plane test
pnpm --dir apps/control-plane test:integration

pnpm --dir apps/web typecheck
pnpm --dir apps/web test
pnpm --dir apps/web e2e
pnpm --dir apps/web build
