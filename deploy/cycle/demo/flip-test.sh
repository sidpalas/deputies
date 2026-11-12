#!/usr/bin/env bash
# Minimal repro for errors at a Cycle deployment-tag flip (see "Tag Flip Result"
# in README.md).
#
#   STACK_ID=... ENVIRONMENT_ID=... ./flip-test.sh setup
#     Deploys flip-test-stack.json twice, as deployment versions v1 and v2
#     (whoami answers "Name: v1" / "Name: v2"), and sets tags live=v1,
#     blue=v1, green=v2. Then create a LINKED record for container `web` and
#     deployment tag `live`, then start the environment so the LB comes up.
#
#   ENVIRONMENT_ID=... HOST=flip.example.com ./flip-test.sh run [FLIPS] [GAP_SECONDS] [LABEL]
#     Probes the load balancer directly (fresh TLS connection per request,
#     4 parallel loops, about 15 requests/s) while flipping between v1 and v2
#     FLIPS times, GAP_SECONDS apart. Prints, per flip, when the old version
#     last answered and the new one first answered (ms after the flip call
#     returned), how many old-version answers remained in the last 2 s before
#     the next flip, and every failed request with its body.
#
#   How it flips (default: move tag `live` with deployments.reconfigure):
#     RECORD=<zone_id>/records/<record_id>        repoint a plain LINKED record
#                                                 between tags blue and green
#     SPLIT_RECORD=<zone_id>/records/<record_id>  swap the weights of a LINKED
#                                                 record with traffic_splitting
#                                                 variants [blue, green]; moves
#                                                 the record's own tag along
#                                                 (SPLIT_MOVE_BASE=0 keeps it)
#     PROBE_SCHEME=http                           probe port 80 instead of 443
#
# Reads CYCLE_API_KEY, CYCLE_HUB_ID and CYCLE_API_BASE_URL. Needs jq, dig, python3.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${ENVIRONMENT_ID:?set ENVIRONMENT_ID}"
cy() {
  curl -sS -X "$1" "$CYCLE_API_BASE_URL$2" -H "Authorization: Bearer $CYCLE_API_KEY" \
    -H "X-Hub-Id: $CYCLE_HUB_ID" -H 'Content-Type: application/json' ${3:+--data "$3"}
}
now_ms() { date +%s%3N; }
iso_ms() { python3 -c 'import sys,datetime;print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp()*1000))' "$1"; }

case ${1:-} in
setup)
  : "${STACK_ID:?set STACK_ID}"
  for v in v1 v2; do
    jq --arg v "$v" '.containers.web.config.runtime.environment_vars.WHOAMI_NAME = $v' \
      "$here/flip-test-stack.json" >"/tmp/flip-test-$v.json"
    STACK_ID=$STACK_ID ENVIRONMENT_ID=$ENVIRONMENT_ID "$here/release.sh" "/tmp/flip-test-$v.json" "$v"
  done
  ENVIRONMENT_ID=$ENVIRONMENT_ID "$here/tag.sh" live v1 blue v1 green v2
  ;;
run)
  : "${HOST:?set HOST}"
  flips=${2:-20} gap=${3:-6} label=${4:-run}
  out=${OUT_DIR:-.}/flip-$label
  ip=$(dig +short "$HOST" A | tail -1)
  echo "probing $HOST at load balancer $ip; logs in $out.*"
  : >"$out.probe" && : >"$out.flips"
  python3 "$here/flip-probe.py" probe "$HOST" "$ip" "$out.probe" 4 ${PROBE_SCHEME:-https} &
  probe=$!
  trap 'kill $probe 2>/dev/null || true' EXIT
  sleep 5
  if [ -n "${RECORD:-}" ]; then
    # RECORD=<zone_id>/records/<record_id>: a plain LINKED record. Flip by
    # repointing it from tag blue (v1) to green (v2) instead of moving a tag.
    current=$(cy GET "/dns/zones/$RECORD" | jq -r 'if .data.type.linked.deployment.match.tag == "blue" then "v1" else "v2" end')
  elif [ -n "${SPLIT_RECORD:-}" ]; then
    # SPLIT_RECORD=<zone_id>/<record_id>: a LINKED record whose traffic_splitting
    # has two variants (tags blue -> v1, green -> v2). Flip by swapping weights.
    current=$(cy GET "/dns/zones/$SPLIT_RECORD" | jq -r \
      'if .data.type.linked.routing.traffic_splitting.variants[0].weight > 0 then "v1" else "v2" end')
  else
    current=$(cy GET "/environments/$ENVIRONMENT_ID" | jq -r '.data.deployments.tags.live')
  fi
  for n in $(seq 1 "$flips"); do
    target=$([ "$current" = v1 ] && echo v2 || echo v1)
    if [ -n "${RECORD:-}" ]; then
      record=$(cy GET "/dns/zones/$RECORD" | jq -c --arg t "$([ "$target" = v1 ] && echo blue || echo green)" \
        '{type: {linked: (.data.type.linked | .deployment.match.tag = $t)}}')
      q=$(now_ms)
      cy PATCH "/dns/zones/$RECORD" "$record" | jq -e .data.id >/dev/null
      c=$(now_ms)
      echo "$n $target $q $q $c" >>"$out.flips"
    elif [ -n "${SPLIT_RECORD:-}" ]; then
      w1=$([ "$target" = v1 ] && echo 1000 || echo 0)
      # The record's own (base) destination also gets a share of traffic, so
      # move it with the weights unless SPLIT_MOVE_BASE=0.
      base=$([ "${SPLIT_MOVE_BASE:-1}" = 1 ] && { [ "$target" = v1 ] && echo blue || echo green; } || echo keep)
      record=$(cy GET "/dns/zones/$SPLIT_RECORD" | jq -c --argjson w1 "$w1" --arg base "$base" \
        '{type: {linked: (.data.type.linked | .routing.traffic_splitting.variants[0].weight = $w1
          | .routing.traffic_splitting.variants[1].weight = (1000 - $w1)
          | if $base == "keep" then . else .deployment.match.tag = $base end)}}')
      q=$(now_ms)
      cy PATCH "/dns/zones/$SPLIT_RECORD" "$record" | jq -e .data.id >/dev/null
      c=$(now_ms)
      echo "$n $target $q $q $c" >>"$out.flips"
    else
      tags=$(cy GET "/environments/$ENVIRONMENT_ID" | jq -c --arg v "$target" '.data.deployments.tags + {live: $v}')
      job=$(cy POST "/environments/$ENVIRONMENT_ID/tasks" \
        "$(jq -nc --argjson t "$tags" '{action: "deployments.reconfigure", contents: {tags: $t}}')" | jq -r .data.job.id)
      until [ "$(cy GET "/jobs/$job" | jq -r .data.state.current)" = completed ]; do sleep 0.25; done
      ev=$(cy GET "/jobs/$job" | jq -r '.data.events | "\(.queued) \(.started) \(.completed)"')
      read -r q s c <<<"$ev"
      echo "$n $target $(iso_ms "$q") $(iso_ms "$s") $(iso_ms "$c")" >>"$out.flips"
    fi
    echo "flip $n -> $target done"
    current=$target
    sleep "$gap"
  done
  sleep 3
  kill $probe || true
  python3 "$here/flip-probe.py" analyze "$out.probe" "$out.flips" | tee "$out.summary"
  ;;
*)
  sed -n '2,28p' "$0"
  exit 1
  ;;
esac
