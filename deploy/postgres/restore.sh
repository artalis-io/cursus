#!/bin/sh
set -eu

if [ "$(find /restore -mindepth 1 -maxdepth 1 | wc -l)" -ne 0 ]; then
  echo 'restore target is not empty; refusing to overwrite it' >&2
  exit 1
fi
backup_id=${CURSUS_BACKUP_ID:-latest}
if [ "$backup_id" = latest ]; then backup_id=$(cat /backup/latest); fi
case "$backup_id" in (*[!0-9TZ]*) echo 'invalid backup id' >&2; exit 1;; esac
source_dir="/backup/base/$backup_id"
test -s "$source_dir/base.tar.gz"
tar -xzf "$source_dir/base.tar.gz" -C /restore
if [ -s "$source_dir/pg_wal.tar.gz" ]; then tar -xzf "$source_dir/pg_wal.tar.gz" -C /restore/pg_wal; fi
printf "restore_command = 'cp /backup/wal/%%f %%p'\n" >> /restore/postgresql.auto.conf
if [ -n "${CURSUS_RECOVERY_TARGET_TIME:-}" ]; then
  case "$CURSUS_RECOVERY_TARGET_TIME" in (*"'"*) echo 'invalid recovery target time' >&2; exit 1;; esac
  printf "recovery_target_time = '%s'\nrecovery_target_action = 'pause'\n" "$CURSUS_RECOVERY_TARGET_TIME" >> /restore/postgresql.auto.conf
fi
touch /restore/recovery.signal
chmod 0700 /restore
printf '{"backup_id":"%s","prepared_at":"%s","target_time":"%s"}\n' \
  "$backup_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CURSUS_RECOVERY_TARGET_TIME:-latest}" > /restore/cursus-restore.json
