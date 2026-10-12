#!/bin/sh
set -eu

backup_id=$(date -u +%Y%m%dT%H%M%SZ)
destination="/backup/base/$backup_id"
staging="/backup/base/.${backup_id}.tmp.$$"
trap 'rm -rf "$staging"' EXIT HUP INT TERM
mkdir -p "$staging" /backup/wal
export PGPASSWORD
PGPASSWORD=$(cat "${CURSUS_REPLICATION_PASSWORD_FILE:?}")
pg_basebackup --host="${CURSUS_PRIMARY_HOST:?}" --port="${CURSUS_PRIMARY_PORT:?}" \
  --username=cursus_replicator --pgdata="$staging" --format=tar --gzip \
  --wal-method=stream --checkpoint=fast --progress --manifest-checksums=SHA256
printf '{"backup_id":"%s","completed_at":"%s"}\n' "$backup_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$staging/cursus-backup.json"
mv "$staging" "$destination"
trap - EXIT HUP INT TERM
printf '%s\n' "$backup_id" > /backup/latest.tmp
mv /backup/latest.tmp /backup/latest
echo "$backup_id"
