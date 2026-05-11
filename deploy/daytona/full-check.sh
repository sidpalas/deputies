#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

./deploy/daytona/start-postgres.sh

export DATABASE_URL=${DATABASE_URL:-postgres://flue:flue@127.0.0.1:5432/flue}
export TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgres://flue:flue@127.0.0.1:5432/flue_test}
export API_AUTH_MODE=${API_AUTH_MODE:-none}

pnpm install --frozen-lockfile
pnpm control-plane:db:migrate

pnpm control-plane:typecheck
pnpm control-plane:test
pnpm control-plane:test:integration

pnpm web:typecheck
pnpm web:test
pnpm web:e2e
pnpm web:build
