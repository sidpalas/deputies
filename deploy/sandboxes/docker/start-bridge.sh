#!/usr/bin/env bash
set -euo pipefail

command_env_args=()
while IFS= read -r name; do
  case "$name" in
    DEPUTIES_SANDBOX_COMMAND_ENV_*) command_env_args+=("$name=${!name}") ;;
  esac
done < <(compgen -e)

exec env -i \
  HOME=/home/sandbox \
  USER=sandbox \
  LOGNAME=sandbox \
  SHELL=/bin/bash \
  PATH=/usr/lib/postgresql/16/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  DEPUTIES_SANDBOX_TOKEN="${DEPUTIES_SANDBOX_TOKEN:-}" \
  DEPUTIES_WORKSPACE="${DEPUTIES_WORKSPACE:-/workspace}" \
  DEPUTIES_SANDBOX_BRIDGE_HOST="${DEPUTIES_SANDBOX_BRIDGE_HOST:-0.0.0.0}" \
  DEPUTIES_SANDBOX_BRIDGE_PORT="${DEPUTIES_SANDBOX_BRIDGE_PORT:-3584}" \
  DEPUTIES_SANDBOX_COMMAND_ENV_DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}" \
  DEPUTIES_SANDBOX_COMMAND_ENV_DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}" \
  DEPUTIES_SANDBOX_COMMAND_ENV_PGDATA="${PGDATA:-/root/.deputies/postgres}" \
  DEPUTIES_SANDBOX_COMMAND_ENV_PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}" \
  DEPUTIES_SANDBOX_COMMAND_ENV_AGENT_BROWSER_EXECUTABLE_PATH="${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/local/bin/deputies-chromium}" \
  DEPUTIES_SANDBOX_COMMAND_ENV_AGENT_BROWSER_IDLE_TIMEOUT_MS="${AGENT_BROWSER_IDLE_TIMEOUT_MS:-120000}" \
  "${command_env_args[@]}" \
  node /opt/deputies/sandbox-bridge/dist/server.js
