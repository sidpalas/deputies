#!/usr/bin/env bash
# Minimal repro: requests fail with "503 no routers for desired route" when a
# Cycle deployment tag is moved between two running deployment versions.
#
# What it does:
#   setup    Deploys a tiny HTTP server (traefik/whoami) twice into the
#            environment, as deployment versions v1 and v2. Each version
#            answers with its own name ("Name: v1" / "Name: v2"). Points tag
#            `live` at v1, creates a LINKED record HOST -> container `web`,
#            tag `live`, and waits until HOST serves over HTTPS.
#   flip     Sends requests to the load balancer in the background, then moves
#            `live` between v1 and v2 (environment task
#            `deployments.reconfigure`, the same tag move as the "Update
#            Deployment Tag Version" pipeline step). Both versions stay running
#            the whole time. Prints, per flip, how many requests failed and the
#            response body of each failure.
#   cleanup  Deletes the LINKED record, the containers and the stack.
#
# Usage:
#   export CYCLE_API_KEY=... CYCLE_HUB_ID=...
#   export ENVIRONMENT_ID=...  # a throwaway environment on a cluster with a live server
#   export ZONE_ID=...         # a Cycle-hosted DNS zone
#   export HOST=flip.example.com   # name for the new record, inside that zone
#   ./tag-flip-repro.sh setup
#   ./tag-flip-repro.sh flip [FLIPS=10] [SECONDS_BETWEEN_FLIPS=8]
#   ./tag-flip-repro.sh cleanup
#
# Needs bash, curl, jq and dig. State (stack and record IDs) is kept in
# ./tag-flip-repro.state; request logs go to ./tag-flip-repro.requests.
set -euo pipefail

API=${CYCLE_API_BASE_URL:-https://api.cycle.io/v1}
STATE=./tag-flip-repro.state
REQUESTS=./tag-flip-repro.requests

# --- Cycle API helpers --------------------------------------------------------

cycle() { # METHOD PATH [JSON_BODY]
  curl -sS -X "$1" "$API$2" \
    -H "Authorization: Bearer $CYCLE_API_KEY" -H "X-Hub-Id: $CYCLE_HUB_ID" \
    -H 'Content-Type: application/json' ${3:+--data "$3"}
}

wait_for_job() { # JOB_ID
  local state
  while true; do
    state=$(cycle GET "/jobs/$1" | jq -r '.data.state.current')
    case $state in
      completed) return 0 ;;
      error | expired)
        echo "job $1 failed: $(cycle GET "/jobs/$1" | jq -c '.data.state.error')" >&2
        return 1
        ;;
    esac
    sleep 1
  done
}

start_environment() {
  wait_for_job "$(cycle POST "/environments/$ENVIRONMENT_ID/tasks" '{"action":"start"}' | jq -r '.data.job.id')"
}

set_live_tag() { # VERSION
  local body
  body=$(jq -nc --arg v "$1" '{action: "deployments.reconfigure", contents: {tags: {live: $v}}}')
  wait_for_job "$(cycle POST "/environments/$ENVIRONMENT_ID/tasks" "$body" | jq -r '.data.job.id')"
}

# The stack: one public container that answers with WHOAMI_NAME.
stack_for_version() { # VERSION
  jq -n --arg version "$1" '{
    version: "1.0",
    containers: {
      web: {
        name: "web",
        stateful: false,
        image: {origin: {type: "docker-hub", details: {target: "traefik/whoami:v1.11.0"}}},
        config: {
          network: {public: "enable", hostname: "web", ports: ["80:8080", "443:8080"]},
          deploy: {instances: 1},
          runtime: {environment_vars: {WHOAMI_PORT_NUMBER: "8080", WHOAMI_NAME: $version}}
        }
      }
    }
  }'
}

# Build the stack for VERSION and deploy the build as that deployment version.
deploy_version() { # STACK_ID VERSION
  local stack_id=$1 version=$2 build body container
  cycle PATCH "/stacks/$stack_id" "$(stack_for_version "$version" | jq -c '{source: {type: "raw", details: .}}')" >/dev/null
  build=$(cycle POST "/stacks/$stack_id/builds" \
    "$(jq -nc --arg v "$version" '{about: {version: $v, description: "tag-flip-repro"}, instructions: {}}')" |
    jq -r '.data.id')
  wait_for_job "$(cycle POST "/stacks/$stack_id/builds/$build/tasks" '{"action":"generate"}' | jq -r '.data.job.id')"
  body=$(jq -nc --arg env "$ENVIRONMENT_ID" --arg v "$version" \
    '{action: "deploy", contents: {environment_id: $env, deployment: {version: $v}}}')
  wait_for_job "$(cycle POST "/stacks/$stack_id/builds/$build/tasks" "$body" | jq -r '.data.job.id')"

  container=$(cycle GET "/containers?filter%5Benvironment%5D=$ENVIRONMENT_ID" |
    jq -r --arg s "$stack_id" --arg v "$version" \
      '.data[] | select(.stack.id == $s and .deployment.version == $v) | .id')
  wait_for_job "$(cycle POST "/containers/$container/tasks" '{"action":"start"}' | jq -r '.data.job.id')"
  echo "deployed $version (container $container)"
}

# --- Request loop -------------------------------------------------------------

# One request per line in $REQUESTS: "<epoch_ms> <http_code> <version>".
# A failed request is followed by a line "  body: <response body>", or the
# curl error when no HTTP response arrived (code 000).
# Every request opens a new TLS connection to the load balancer's IP, so DNS
# and connection reuse play no part.
request_loop() { # LOAD_BALANCER_IP
  local ip=$1 response code body version
  while true; do
    # The last line is "<http_code> <curl error, if any>".
    response=$(curl -s -m 3 --resolve "$HOST:443:$ip" -w '\n%{http_code} %{errormsg}' "https://$HOST/" || true)
    code=${response##*$'\n'}
    body=${response%$'\n'*}
    if [ "${code%% *}" = 000 ]; then body="curl: ${code#* }"; fi
    code=${code%% *}
    version=$(sed -n 's/^Name: //p' <<<"$body")
    if [ "$code" = 200 ]; then
      echo "$(date +%s%3N) $code $version" >>"$REQUESTS"
    else
      printf '%s %s -\n  body: %s\n' "$(date +%s%3N)" "${code:-000}" "$(tr '\n' ' ' <<<"$body")" >>"$REQUESTS"
    fi
    sleep 0.1
  done
}

# --- Commands -----------------------------------------------------------------

setup() {
  : "${ZONE_ID:?set ZONE_ID}" "${HOST:?set HOST}"
  local stack_id zone_origin record_name record_body record_id
  stack_id=$(cycle POST /stacks "$(stack_for_version v1 |
    jq -c '{name: "tag-flip-repro", source: {type: "raw", details: .}}')" | jq -r '.data.id')
  echo "STACK_ID=$stack_id" >"$STATE"

  start_environment # discovery must be running before containers start
  deploy_version "$stack_id" v1
  deploy_version "$stack_id" v2
  set_live_tag v1
  echo "tag live -> v1"

  zone_origin=$(cycle GET "/dns/zones/$ZONE_ID" | jq -r '.data.origin')
  record_name=${HOST%".$zone_origin"}
  [ "$record_name" = "$HOST" ] && record_name=@
  record_body=$(jq -nc --arg name "$record_name" --arg env "$ENVIRONMENT_ID" '{
    name: $name,
    type: {linked: {
      deployment: {environment_id: $env, match: {container: "web", tag: "live"}},
      features: {tls: {enable: true}, geodns: {enable: false}}
    }}
  }')
  record_id=$(cycle POST "/dns/zones/$ZONE_ID/records" "$record_body" | jq -r '.data.id')
  echo "RECORD_ID=$record_id" >>"$STATE"
  echo "created LINKED record $HOST -> web @ tag live"

  # Starting the environment brings up the load balancer for the public container.
  start_environment
  echo -n "waiting for https://$HOST to answer (DNS and TLS certificate)"
  until curl -s -m 3 "https://$HOST/" | grep -q '^Name: v1'; do
    echo -n .
    sleep 5
  done
  echo " ok"
}

flip() {
  : "${HOST:?set HOST}"
  local flips=${1:-10} gap=${2:-8} ip current target started finished
  ip=$(dig +short "$HOST" A | tail -1)
  echo "load balancer for $HOST: $ip"
  : >"$REQUESTS"

  # Two loops in parallel give about 10 requests per second.
  request_loop "$ip" &
  LOOP_1=$!
  request_loop "$ip" &
  LOOP_2=$!
  trap 'kill $LOOP_1 $LOOP_2 2>/dev/null || true' EXIT
  sleep 5

  current=v1
  set_live_tag v1
  for n in $(seq 1 "$flips"); do
    target=$([ "$current" = v1 ] && echo v2 || echo v1)
    started=$(date +%s%3N)
    set_live_tag "$target"
    finished=$(date +%s%3N)
    sleep "$gap"
    report_flip "$n" "$current" "$target" "$started" "$finished" "$(date +%s%3N)"
    current=$target
  done

  echo
  echo "total: $(grep -c ' 200 ' "$REQUESTS") ok, $(grep -cv -e ' 200 ' -e '^  body' "$REQUESTS") failed"
  echo "distinct failure bodies:"
  sed -n 's/^  body: /  /p' "$REQUESTS" | sort | uniq -c
}

# Summarise the requests sent between one flip and the end of its wait.
report_flip() { # N FROM TO STARTED_MS FINISHED_MS END_MS
  awk -v n="$1" -v from="$2" -v to="$3" -v start="$4" -v done_ms="$5" -v end="$6" '
    /^  body/ { next }
    $1 >= start && $1 < end {
      total++
      if ($2 != 200) { failed++; when = when sprintf(" %+dms(%s)", $1 - done_ms, $2) }
      else if ($3 == to && first_new == "") first_new = $1 - done_ms
    }
    END {
      printf "flip %2d %s -> %s: tag job took %dms; first %s answer %s after it finished; %d of %d requests failed%s\n",
        n, from, to, done_ms - start, to, (first_new == "" ? "never" : sprintf("%+dms", first_new)),
        failed, total, (failed ? " at" when : "")
    }' "$REQUESTS"
}

cleanup() {
  : "${ZONE_ID:?set ZONE_ID}"
  # shellcheck disable=SC1090
  source "$STATE"
  local container
  cycle DELETE "/dns/zones/$ZONE_ID/records/$RECORD_ID" >/dev/null && echo "deleted record"
  for container in $(cycle GET "/containers?filter%5Benvironment%5D=$ENVIRONMENT_ID" |
    jq -r --arg s "$STACK_ID" '.data[] | select(.stack.id == $s) | .id'); do
    wait_for_job "$(cycle DELETE "/containers/$container" | jq -r '.data.job.id')"
    echo "deleted container $container"
  done
  wait_for_job "$(cycle DELETE "/stacks/$STACK_ID" | jq -r '.data.job.id')" && echo "deleted stack"
  rm -f "$STATE"
}

case ${1:-} in
  setup | flip | cleanup)
    : "${CYCLE_API_KEY:?set CYCLE_API_KEY}" "${CYCLE_HUB_ID:?set CYCLE_HUB_ID}" "${ENVIRONMENT_ID:?set ENVIRONMENT_ID}"
    ;;
esac
case ${1:-} in
  setup) setup ;;
  flip) flip "${2:-10}" "${3:-8}" ;;
  cleanup) cleanup ;;
  *)
    sed -n '2,29p' "$0"
    exit 1
    ;;
esac
