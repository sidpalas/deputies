#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE=(docker compose -f "$ROOT_DIR/deploy/docker-compose/docker-compose.all.yml" -f "$ROOT_DIR/deploy/docker-compose/docker-compose.smoke.yml")

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
"${COMPOSE[@]}" up -d --build postgres seaweedfs control-plane-migrate control-plane web

for _ in {1..60}; do
  if curl -fs http://127.0.0.1:15173/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS http://127.0.0.1:15173/health >/dev/null

PLAYWRIGHT_SKIP_WEB_SERVER=true PLAYWRIGHT_BASE_URL=http://127.0.0.1:15173 RUN_FULL_STACK_SMOKE=true pnpm --dir "$ROOT_DIR/apps/web" exec playwright test e2e/full-stack-smoke.spec.ts --config playwright.config.ts --project chromium
