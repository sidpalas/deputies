#!/usr/bin/env bash
# On-camera downtime monitor: requests /health about once a second and prints
# the elapsed time, status, the IP that answered, and total seconds spent down.
# Usage: ./watch-health.sh https://cycle.deputies.dev [logfile]
# Each request opens a new connection and resolves DNS again, so the loop
# follows the LINKED record when the load balancer moves. Local resolver
# caching still applies; run it on a machine using a public resolver.
set -uo pipefail
url=${1:?usage: watch-health.sh URL [logfile]}
log=${2:-/dev/null}
start=$(date +%s)
down=0
prev=$start
prev_state=UP
while :; do
  now=$(date +%s)
  [ "$prev_state" = DOWN ] && down=$((down + now - prev))
  out=$(curl -s -o /dev/null -m 2 -w '%{http_code} %{remote_ip}' "$url/health" 2>/dev/null)
  code=${out%% *}
  ip=${out#* }
  if [ "$code" = 200 ]; then state=UP; else state=DOWN; fi
  line=$(printf '%s  T+%4ss  %-4s %3s  %-39s  down %ss' \
    "$(date -u +%H:%M:%S)" $((now - start)) "$state" "$code" "$ip" "$down")
  echo "$line"
  echo "$line" >> "$log"
  prev=$now
  prev_state=$state
  sleep 1
done
