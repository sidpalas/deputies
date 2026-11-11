#!/usr/bin/env bash
# Pushes a stack file to Cycle, builds it (importing its images), deploys the
# build into an environment, optionally as a Cycle deployment version, and
# starts the new containers.
#
# Usage: STACK_ID=... ENVIRONMENT_ID=... ./release.sh STACK_FILE [VERSION]
#   VERSION  deployment version such as v0.27.1; omit to deploy unversioned
#
# Reads CYCLE_API_KEY, CYCLE_HUB_ID and CYCLE_API_BASE_URL. Moving traffic to
# the new version is a separate step: ./tag.sh live v0.27.1
set -euo pipefail
: "${STACK_ID:?set STACK_ID}" "${ENVIRONMENT_ID:?set ENVIRONMENT_ID}"
file=${1:?usage: release.sh STACK_FILE [VERSION]}
version=${2:-}

cy() {
  curl -sS -X "$1" "$CYCLE_API_BASE_URL$2" -H "Authorization: Bearer $CYCLE_API_KEY" \
    -H "X-Hub-Id: $CYCLE_HUB_ID" -H 'Content-Type: application/json' ${3:+--data "$3"}
}
wait_job() {
  local state
  while :; do
    state=$(cy GET "/jobs/$1" | jq -r '.data.state.current')
    case $state in completed) return 0 ;; error | expired) cy GET "/jobs/$1" | jq -c '.data.state.error'; return 1 ;; esac
    sleep 2
  done
}
start=$(date +%s)

cy PATCH "/stacks/$STACK_ID" "$(jq -c '{source: {type: "raw", details: .}}' "$file")" | jq -e '.data.id' >/dev/null
build=$(cy POST "/stacks/$STACK_ID/builds" "$(jq -n --arg v "${version:-unversioned}" \
  '{about: {version: $v, description: "release.sh"}, instructions: {}}')" | jq -r '.data.id')
wait_job "$(cy POST "/stacks/$STACK_ID/builds/$build/tasks" '{"action":"generate"}' | jq -r '.data.job.id')"
echo "build $build generated (images imported) in $(($(date +%s) - start))s"

deploy=$(jq -n --arg env "$ENVIRONMENT_ID" --arg v "$version" \
  '{action: "deploy", contents: ({environment_id: $env} + (if $v == "" then {} else {deployment: {version: $v}} end))}')
wait_job "$(cy POST "/stacks/$STACK_ID/builds/$build/tasks" "$deploy" | jq -r '.data.job.id')"
echo "build deployed in $(($(date +%s) - start))s"

ids=$(cy GET "/containers?filter%5Benvironment%5D=$ENVIRONMENT_ID" | jq -r --arg v "$version" --arg s "$STACK_ID" \
  '.data[] | select(.stack.id == $s) | select((.deployment.version // "") == $v) | select(.state.current != "running") | .id')
for id in $ids; do cy POST "/containers/$id/tasks" '{"action":"start"}' >/dev/null; done
for id in $ids; do
  until [ "$(cy GET "/containers/$id/instances" | jq -r '[.data[].state.current] | length > 0 and all(. == "running")')" = true ]; do sleep 2; done
done
echo "containers running in $(($(date +%s) - start))s"
