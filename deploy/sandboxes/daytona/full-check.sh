#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

./deploy/sandboxes/daytona/start-postgres.sh

export DATABASE_URL=${DATABASE_URL:-postgres://deputies:deputies@127.0.0.1:5432/deputies}
export TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgres://deputies:deputies@127.0.0.1:5432/deputies_test}
export API_AUTH_MODE=${API_AUTH_MODE:-none}

mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --dir apps/control-plane db:migrate

mise exec -- pnpm --dir apps/control-plane typecheck
mise exec -- pnpm --dir apps/control-plane test
mise exec -- pnpm --dir apps/control-plane test:integration

mise exec -- pnpm --dir apps/web typecheck
mise exec -- pnpm --dir apps/web test
mise exec -- pnpm --dir apps/web e2e
mise exec -- pnpm --dir apps/web build
