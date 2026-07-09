#!/usr/bin/env bash
set -euo pipefail

output=${1:?Pass --load or --push}
if [[ "$output" != "--load" && "$output" != "--push" ]]; then
  echo "Expected --load or --push, received: $output" >&2
  exit 2
fi

docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  -f Dockerfile \
  -t "${SUPERSERVE_IMAGE:-ghcr.io/sidpalas/deputies-superserve-sandbox:latest}" \
  "$output" \
  ../../..
