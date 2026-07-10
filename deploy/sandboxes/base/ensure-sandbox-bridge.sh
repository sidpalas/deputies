#!/usr/bin/env bash
set -euo pipefail

pid_file=/tmp/deputies-sandbox-bridge.pid
log_file=/tmp/deputies-sandbox-bridge.log
health_url="http://127.0.0.1:${DEPUTIES_SANDBOX_BRIDGE_PORT:-3584}/health"
export HEALTH_URL="$health_url"

health() {
  node /opt/deputies/sandbox-bridge/dist/healthcheck.js >/dev/null 2>&1
}

start_bridge() {
  DEPUTIES_SANDBOX_BRIDGE_HOST=0.0.0.0 \
    DEPUTIES_SANDBOX_BRIDGE_PORT="${DEPUTIES_SANDBOX_BRIDGE_PORT:-3584}" \
    nohup node /opt/deputies/sandbox-bridge/dist/server.js >> "$log_file" 2>&1 &
  echo $! > "$pid_file"
}

if ! health; then
  [ -f "$pid_file" ] && kill "$(cat "$pid_file")" 2>/dev/null || true
  start_bridge
fi

for _ in {1..20}; do
  health && exit 0
  sleep 0.25
done

echo "deputies sandbox bridge did not become ready" >&2
exit 1
