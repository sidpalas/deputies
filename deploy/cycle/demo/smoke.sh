#!/usr/bin/env bash
# Logs in to a Deputies deployment, starts a session with one real agent task,
# waits for the run to finish, and prints the session ID, status and last reply.
# Usage: DEPUTIES_URL=https://host DEPUTIES_PASSWORD=... ./smoke.sh ["prompt"]
set -euo pipefail
: "${DEPUTIES_URL:?set DEPUTIES_URL}"
: "${DEPUTIES_PASSWORD:?set DEPUTIES_PASSWORD}"
prompt=${1:-"Create hello.py that prints the first 10 Fibonacci numbers, run it, and tell me the output."}
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT

curl -fsS -c "$jar" -X POST "$DEPUTIES_URL/auth/login" -H 'Content-Type: application/json' \
  --data "$(jq -n --arg p "$DEPUTIES_PASSWORD" '{username: "deputies", password: $p}')" >/dev/null

session=$(curl -fsS -b "$jar" -X POST "$DEPUTIES_URL/sessions" -H 'Content-Type: application/json' \
  --data '{"title": "Cycle smoke test"}' | jq -r '.session.id // .id')
curl -fsS -b "$jar" -X POST "$DEPUTIES_URL/sessions/$session/messages" -H 'Content-Type: application/json' \
  --data "$(jq -n --arg p "$prompt" '{prompt: $p}')" >/dev/null
echo "session $session"

start=$(date +%s)
while :; do
  status=$(curl -fsS -b "$jar" "$DEPUTIES_URL/sessions/$session" | jq -r '.session.status // .status')
  echo "$(( $(date +%s) - start ))s $status"
  case $status in idle | completed | failed | error) break ;; esac
  sleep 5
done

echo "--- tools and reply"
curl -fsS -b "$jar" "$DEPUTIES_URL/sessions/$session/events" | jq -r '
  [.events[] | select(.type == "tool_started" or .type == "agent_text_delta" or .type == "run_failed")]
  | map(if .type == "tool_started" then "\n[\(.payload.toolName)] \(.payload.args.command // .payload.args.path // "")\n"
        elif .type == "run_failed" then "\nFAILED: \(.payload.error)\n"
        else .payload.text end) | join("")'
