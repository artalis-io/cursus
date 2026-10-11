#!/bin/bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)

# Static safety assertions do not require customer data or Docker.
grep -q 'create_host_path: false' "$script_dir/../compose.yaml"
grep -q '127.0.0.1:' "$script_dir/../compose.yaml"
! grep -Eq '(^|[[:space:]])privileged:|network_mode:[[:space:]]*host|docker.sock' "$script_dir/../compose.yaml"
grep -q '^\.env$' "$script_dir/../.dockerignore"
grep -q '^\*\.osm\.pbf$' "$script_dir/../.dockerignore"

# Exercise the fail-fast path without revealing or requiring a real dataset.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/dataset" "$tmp/state" "$tmp/osm"
if DATASET_ROOT="$tmp/dataset" DISPATCH_DATA_DIR="$tmp/state/app" \
   DISPATCH_UPLOADS_DIR="$tmp/state/uploads" GEOCODE_CACHE_DIR="$tmp/state/cache" \
   SURGE_BIN=/bin/true MATRIX_BUILD_BIN=/bin/true NEXUS_DIR=/bin VELO_GRAPH=/bin/true \
   "$script_dir/entrypoint.sh" /bin/true 2>/dev/null; then
    echo "expected a missing dataset to fail preflight" >&2
    exit 1
fi
echo "Deployment static and missing-dataset checks passed"
