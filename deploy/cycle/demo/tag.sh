#!/usr/bin/env bash
# Points a Cycle deployment tag at a version. LINKED records that follow the
# tag switch to that version's containers at once.
# Usage: ENVIRONMENT_ID=... ./tag.sh live v0.27.1 [next v0.27.2 ...]
# Tags not named keep their current version.
set -euo pipefail
: "${ENVIRONMENT_ID:?set ENVIRONMENT_ID}"
cy() {
  curl -sS -X "$1" "$CYCLE_API_BASE_URL$2" -H "Authorization: Bearer $CYCLE_API_KEY" \
    -H "X-Hub-Id: $CYCLE_HUB_ID" -H 'Content-Type: application/json' ${3:+--data "$3"}
}
tags=$(cy GET "/environments/$ENVIRONMENT_ID" | jq '.data.deployments.tags // {}')
while [ $# -ge 2 ]; do
  tags=$(jq --arg t "$1" --arg v "$2" '.[$t] = $v' <<<"$tags")
  shift 2
done
job=$(cy POST "/environments/$ENVIRONMENT_ID/tasks" \
  "$(jq -n --argjson tags "$tags" '{action: "deployments.reconfigure", contents: {tags: $tags}}')" | jq -r '.data.job.id')
until [ "$(cy GET "/jobs/$job" | jq -r '.data.state.current')" = completed ]; do sleep 1; done
echo "tags: $(jq -c . <<<"$tags")"
