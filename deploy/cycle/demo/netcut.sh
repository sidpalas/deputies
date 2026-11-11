#!/usr/bin/env bash
# Runs in the netcut container (privileged, host network and PID namespaces).
# MODE=probe  prints the host's established TCP connections and resolved Cycle
#             endpoints, then idles.
# MODE=cut    drops all traffic between this node and Cycle's control plane:
#             the remote ends of the host's current connections, every address
#             of api/console/portal.cycle.io, and CUT_TARGETS, except EXCLUDE.
#             Waits CUT_SECONDS, then deletes its rules.
# Leave other cluster nodes in EXCLUDE, or run it after the node is alone.
# The rules live in their own chain, NETCUT, so removal is one flush.
set -u
log() { echo "$(date -u +%H:%M:%S) $*"; }

endpoints() {
  # Public remote addresses of the host's established TCP connections (the
  # Cycle agent's channels; containers have their own network namespaces).
  ss -tnH state established 2>/dev/null | awk '{print $4}' |
    sed -E 's/^\[?([^]]+)\]?:[0-9]+$/\1/' |
    grep -Ev '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|fd|fe80|::1)' | sort -u
}

case ${MODE:-probe} in
probe)
  log "host connections:"
  ss -tnpH state established | sed 's/^/  /'
  for h in api.cycle.io console.cycle.io hub.cycle.io nodes.cycle.io portal.cycle.io; do
    log "$h -> $(dig +short "$h" | tr '\n' ' ')"
  done
  exec sleep infinity
  ;;
cut)
  # Everything the host is connected to now, plus every address of Cycle's
  # API, console and portal hosts, minus EXCLUDE (cluster peers you keep).
  resolved=$(for h in api.cycle.io console.cycle.io portal.cycle.io; do dig +short A "$h"; dig +short AAAA "$h"; done | grep -E '^[0-9a-f.:]+$')
  targets=$(printf '%s\n' ${CUT_TARGETS:-} $(endpoints) $resolved | sort -u | grep -vxF -f <(printf '%s\n' ${EXCLUDE:-none}) | tr '\n' ' ')
  log "cutting node from: $targets for ${CUT_SECONDS:-600}s"
  for ipt in iptables ip6tables; do
    $ipt -N NETCUT 2>/dev/null; $ipt -F NETCUT
    $ipt -C OUTPUT -j NETCUT 2>/dev/null || $ipt -I OUTPUT 1 -j NETCUT
    $ipt -C INPUT -j NETCUT 2>/dev/null || $ipt -I INPUT 1 -j NETCUT
  done
  for ip in $targets; do
    case $ip in *:*) ipt=ip6tables ;; *) ipt=iptables ;; esac
    $ipt -A NETCUT -d "$ip" -j DROP
    $ipt -A NETCUT -s "$ip" -j DROP
  done
  # Kill the agent's open sockets so the cut takes effect immediately.
  for ip in $targets; do ss -K dst "$ip" >/dev/null 2>&1; done
  log "rules in place"
  sleep "${CUT_SECONDS:-600}"
  for ipt in iptables ip6tables; do
    $ipt -D OUTPUT -j NETCUT; $ipt -D INPUT -j NETCUT; $ipt -F NETCUT; $ipt -X NETCUT
  done
  log "rules removed; node can reach Cycle again"
  exec sleep infinity
  ;;
esac
