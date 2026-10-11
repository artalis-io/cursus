#!/bin/sh
set -eu
base=${CURSUS_URL:-http://127.0.0.1:${CURSUS_PORT:-8091}}
body=$(curl --fail --silent --show-error --max-time 10 "$base/api/health")
printf '%s' "$body" | grep -q '"status":"ok"'
curl --fail --silent --show-error --max-time 10 "$base/" >/dev/null
curl --fail --silent --show-error --max-time 15 "$base/tiles.vector.json" >/dev/null
echo "Cursus HTTP, API and Carta proxy smoke checks passed"
