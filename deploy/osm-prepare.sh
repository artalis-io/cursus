#!/bin/bash
set -Eeuo pipefail

root=/data/osm
pbf_file=${OSM_PBF_FILE:-hungary-latest.osm.pbf}
asset=${OSM_ASSET_NAME:-default}
revision=${OTTO_REVISION:-unknown}

[[ "$pbf_file" != /* && "$pbf_file" != *..* ]] || { echo "prepare: OSM_PBF_FILE must be a safe relative path" >&2; exit 2; }
[[ "$asset" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "prepare: invalid OSM_ASSET_NAME" >&2; exit 2; }
[[ -d "$root" && -w "$root" ]] || { echo "prepare: /data/osm must exist and be writable" >&2; exit 2; }

exec 9>"$root/.cursus-osm-prepare.lock"
flock -n 9 || { echo "prepare: another preparation job holds the lock" >&2; exit 3; }

pbf="$root/$pbf_file"
if [[ ! -e "$pbf" ]]; then
    [[ -n "${OSM_PBF_URL:-}" ]] || { echo "prepare: PBF missing and OSM_PBF_URL is empty" >&2; exit 4; }
    mkdir -p "$(dirname "$pbf")"
    partial="${pbf}.download.$$"
    trap 'rm -f "${partial:-}"; [[ -z "${stage:-}" ]] || rm -rf "$stage"' EXIT INT TERM
    echo "prepare: downloading configured PBF (contents are not logged)"
    curl --fail --location --retry 5 --retry-all-errors --connect-timeout 20 \
         --speed-time 60 --speed-limit 1024 --output "$partial" "$OSM_PBF_URL"
    size=$(stat -c %s "$partial")
    (( size >= 65536 )) || { echo "prepare: download is too small to be a valid PBF" >&2; exit 4; }
    [[ ! -e "$pbf" ]] || { echo "prepare: target appeared concurrently; refusing to overwrite" >&2; exit 4; }
    mv "$partial" "$pbf"
    echo "prepare: PBF published atomically"
else
    [[ -f "$pbf" && -r "$pbf" ]] || { echo "prepare: configured PBF is not a readable regular file" >&2; exit 4; }
    echo "prepare: reusing existing PBF without network access"
fi

size=$(stat -c %s "$pbf")
(( size >= 65536 )) || { echo "prepare: PBF is too small to be valid" >&2; exit 4; }
pbf_sha=$(sha256sum "$pbf" | awk '{print $1}')
tools_sha=$(sha256sum /app/velo-route-server /app/carta-tile-server /app/locus-geocoder | sha256sum | awk '{print $1}')
identity=$(printf '%s\n%s\n%s\n' "$pbf_sha" "$revision" "$tools_sha" | sha256sum | awk '{print $1}')
base="$root/cursus/$asset"
version="$base/versions/$identity"

if [[ -f "$version/COMPLETE" && -s "$version/map.vlg" && -s "$version/map.idx" && -s "$version/map.lcx" ]]; then
    mkdir -p "$base"
    ln -sfn "versions/$identity" "$base/current.next"
    mv -Tf "$base/current.next" "$base/current"
    echo "prepare: compatible completed assets already exist; reused"
    exit 0
fi

available=$(df -B1 --output=avail "$root" | tail -1 | tr -d ' ')
estimate=$((size * 4))
echo "prepare: source bytes=$size free bytes=$available estimated requirement=$estimate"
(( available >= estimate )) || { echo "prepare: insufficient free space for conservative 4x estimate" >&2; exit 5; }

mkdir -p "$base/versions"
stage="$base/.stage-$identity-$$"
mkdir "$stage"
trap 'rm -f "${partial:-}"; rm -rf "$stage"' EXIT INT TERM

echo "prepare: building Velo, Locus and Carta indexes with OTTO $revision"
/app/velo-route-server --save-index "$stage/map.vlg" "$pbf" --build-only
/app/locus-geocoder --build-only -S "$stage/map.lcx" "$pbf"
/app/carta-tile-server --save-index "$stage/map.idx" "$pbf" --build-only
for output in map.vlg map.lcx map.idx; do
    [[ -s "$stage/$output" ]] || { echo "prepare: converter did not produce $output" >&2; exit 6; }
done

# Velo and Carta validate their native formats by loading and re-saving them.
/app/velo-route-server --save-index "$stage/check.vlg" "$stage/map.vlg" --build-only
/app/carta-tile-server --save-index "$stage/check.idx" "$stage/map.idx" --build-only
rm -f "$stage/check.vlg" "$stage/check.idx"

# Locus has no validate-only flag, so prove the mapped index reaches ready state
# on an unexposed port, then terminate it. Nothing leaves this job container.
/app/locus-geocoder -p 18083 "$stage/map.lcx" >/tmp/locus-validate.log 2>&1 &
locus_pid=$!
ready=0
for _ in $(seq 1 60); do
    if curl --fail --silent --max-time 2 http://127.0.0.1:18083/api/v1/health >/dev/null; then ready=1; break; fi
    sleep 1
done
kill "$locus_pid" 2>/dev/null || true
wait "$locus_pid" 2>/dev/null || true
(( ready == 1 )) || { echo "prepare: Locus could not load its generated index" >&2; exit 6; }

cat >"$stage/manifest.json" <<EOF
{"status":"complete","pbf_file":"$pbf_file","pbf_sha256":"$pbf_sha","pbf_bytes":$size,"otto_revision":"$revision","converter_sha256":"$tools_sha","identity":"$identity"}
EOF
date -u +%Y-%m-%dT%H:%M:%SZ >"$stage/COMPLETE"
if [[ -e "$version" ]]; then
    echo "prepare: removing incomplete managed version for this exact identity"
    rm -rf "$version"
fi
mv "$stage" "$version"
stage=
ln -sfn "versions/$identity" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
trap - EXIT INT TERM
echo "prepare: published $asset/$identity; older completed versions retained"
