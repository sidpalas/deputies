#!/usr/bin/env bash

if [[ -f ../../../.env.local ]]; then
  set -a
  source ../../../.env.local
  set +a
fi

export SUPERSERVE_TEMPLATE=${SUPERSERVE_TEMPLATE:-deputies}
export SUPERSERVE_IMAGE=${SUPERSERVE_IMAGE:-${DAYTONA_IMAGE:-ghcr.io/sidpalas/deputies-daytona-sandbox:latest}}
