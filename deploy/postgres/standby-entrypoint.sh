#!/bin/sh
set -eu

if [ "$(id -u)" = 0 ]; then
  mkdir -p "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
  exec gosu postgres "$0" "$@"
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  if [ -e "$PGDATA" ] && [ "$(find "$PGDATA" -mindepth 1 -maxdepth 1 | wc -l)" -ne 0 ]; then
    echo 'standby PGDATA is non-empty but uninitialized; refusing to overwrite it' >&2
    exit 1
  fi
  export PGPASSWORD
  PGPASSWORD=$(cat "${CURSUS_REPLICATION_PASSWORD_FILE:?}")
  pg_basebackup --host="${CURSUS_PRIMARY_HOST:?}" --port="${CURSUS_PRIMARY_PORT:?}" \
    --username=cursus_replicator --pgdata="$PGDATA" --wal-method=stream --checkpoint=fast \
    --write-recovery-conf --progress
  chmod 0700 "$PGDATA"
fi

exec docker-entrypoint.sh "$@"
