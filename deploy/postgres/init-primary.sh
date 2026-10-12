#!/bin/sh
set -eu

mkdir -p /backup/wal /backup/base

password=$(cat /run/secrets/postgres_replication_password)
case "$password" in
  '') echo 'replication password is empty' >&2; exit 1 ;;
  *[!A-Za-z0-9._~-]*) echo 'replication password contains unsupported characters' >&2; exit 1 ;;
esac
case "${CURSUS_REPLICATION_CIDR:?}" in
  *[!0-9a-fA-F:./]*) echo 'invalid replication CIDR' >&2; exit 1 ;;
esac

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=repl_password="$password" <<'SQL'
CREATE ROLE cursus_replicator WITH REPLICATION LOGIN PASSWORD :'repl_password';
SQL
printf 'host replication cursus_replicator %s scram-sha-256\n' "$CURSUS_REPLICATION_CIDR" >> "$PGDATA/pg_hba.conf"
