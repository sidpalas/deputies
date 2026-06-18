#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE=(docker compose -f "$ROOT_DIR/deploy/docker-compose/docker-compose.combined.yml" -f "$ROOT_DIR/deploy/docker-compose/docker-compose.smoke.yml")
if [[ -n "${DOCKER_COMPOSE_SMOKE_BASE_URL:-}" ]]; then
  BASE_URL="$DOCKER_COMPOSE_SMOKE_BASE_URL"
elif [[ "${AGENT_CI_LOCAL:-}" == "true" ]]; then
  BASE_URL="http://host.docker.internal:15173"
else
  BASE_URL="http://127.0.0.1:15173"
fi

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}

show_section() {
  printf '\n--- %s ---\n' "$1"
}

curl_smoke_api() {
  local path="$1"
  show_section "GET $path"
  curl -fsS "$BASE_URL$path" || true
  printf '\n'
}

latest_session_id() {
  node -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const sessions = (JSON.parse(input).sessions ?? []).sort((a, b) =>
      String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
    );
    if (sessions[0]?.id) process.stdout.write(sessions[0].id);
  } catch {}
});
'
}

show_diagnostics() {
  local status="$1"
  set +e

  show_section "Docker Compose smoke failed with exit $status"
  show_section "Docker Compose ps"
  "${COMPOSE[@]}" ps

  show_section "Docker Compose config"
  "${COMPOSE[@]}" config

  show_section "Docker Compose logs"
  "${COMPOSE[@]}" logs --no-color --tail=400 control-plane-migrate control-plane web postgres seaweedfs

  curl_smoke_api /health
  curl_smoke_api /repositories
  curl_smoke_api /models

  show_section "GET /sessions"
  local sessions_json
  sessions_json="$(curl -fsS "$BASE_URL/sessions" 2>/dev/null)"
  printf '%s\n' "$sessions_json"

  local session_id
  session_id="$(printf '%s' "$sessions_json" | latest_session_id)"
  if [[ -n "$session_id" ]]; then
    curl_smoke_api "/sessions/$session_id/messages"
    curl_smoke_api "/sessions/$session_id/events?limit=200"
    curl_smoke_api "/sessions/$session_id/artifacts"
  fi
}

on_exit() {
  local status="$?"
  if [[ "$status" -ne 0 ]]; then
    show_diagnostics "$status"
  fi
  cleanup
  exit "$status"
}
trap on_exit EXIT

cleanup
"${COMPOSE[@]}" up -d --build postgres seaweedfs control-plane-migrate control-plane web

for _ in {1..60}; do
  if curl -fs "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS "$BASE_URL/health" >/dev/null

PLAYWRIGHT_SKIP_WEB_SERVER=true PLAYWRIGHT_BASE_URL="$BASE_URL" RUN_FULL_STACK_SMOKE=true pnpm --dir "$ROOT_DIR/apps/web" exec playwright test e2e/full-stack-smoke.spec.ts --config playwright.config.ts --project chromium
