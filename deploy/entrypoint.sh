#!/bin/sh
set -eu

required_dataset_files='input/orders.json input/orders.geocoded.json input/vehicles.json results/perday/day1_request.json results/perday/day1_solution.json results/perday/day2_request.json results/perday/day2_solution.json'
for relative in $required_dataset_files; do
    if [ ! -f "${DATASET_ROOT:?DATASET_ROOT is required}/$relative" ]; then
        echo "Cursus preflight: required dataset file is missing: $relative" >&2
        exit 1
    fi
done

for path in "${SURGE_BIN:?}" "${MATRIX_BUILD_BIN:?}" "${NEXUS_DIR:?}/nx_pipeline" "${VELO_GRAPH:?}"; do
    if [ ! -e "$path" ]; then
        echo "Cursus preflight: required dependency is missing: $path" >&2
        exit 1
    fi
done

for directory in "${DISPATCH_DATA_DIR:?}" "${DISPATCH_UPLOADS_DIR:?}" "${GEOCODE_CACHE_DIR:?}"; do
    mkdir -p "$directory" || {
        echo "Cursus preflight: state path is not writable: $directory" >&2
        exit 1
    }
done

if [ "${CURSUS_AUTH_REQUIRED:-0}" = 1 ]; then
    for secret in "${CURSUS_AUTH_ALLOWED_EMAILS_FILE:?}" "${RESEND_API_KEY_FILE:?}"; do
        if [ ! -s "$secret" ]; then
            echo "Cursus preflight: required authentication secret is missing or empty" >&2
            exit 1
        fi
    done
fi

dataset_id=${CURSUS_DATASET_ID:-customer-dataset}
case "$dataset_id" in (*[!A-Za-z0-9._-]*) echo "Cursus preflight: invalid CURSUS_DATASET_ID" >&2; exit 1;; esac
identity=$(for relative in $required_dataset_files; do sha256sum "$DATASET_ROOT/$relative"; done | sha256sum | awk '{print $1}')
identity_dir="$DISPATCH_DATA_DIR/deployment"
mkdir -p "$identity_dir"
identity_tmp="$identity_dir/dataset-identity.json.tmp.$$"
printf '{"dataset_id":"%s","manifest_sha256":"%s"}\n' "$dataset_id" "$identity" >"$identity_tmp"
mv "$identity_tmp" "$identity_dir/dataset-identity.json"

exec "$@"
