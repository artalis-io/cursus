#!/usr/bin/env python3
"""Create a production base backup and verify it in an isolated PostgreSQL container."""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class RecoveryError(RuntimeError): pass


def run(argv: list[str], timeout: int = 900, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        raise RecoveryError((result.stderr.strip() or result.stdout.strip())[-2000:])
    return result


def ssh(alias: str, command: str, timeout: int = 900) -> subprocess.CompletedProcess[str]:
    try:
        return run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", alias, command], timeout)
    except RecoveryError as exc:
        raise RecoveryError(f"remote command failed on {alias}: {exc or 'no diagnostic output'}") from exc


def verify(config: Path, nonce: str) -> dict[str, object]:
    cfg = json.loads(config.read_text())
    primary = next(node for node in cfg["nodes"] if node["role"] == "primary")
    directory, env_file = primary["deployment_dir"], primary["env_file"]
    prefix = (f"cd {shlex.quote(directory)} && docker compose --env-file {shlex.quote(env_file)} "
              "-f compose.stateful.yaml")
    started = time.monotonic()
    try: backup = ssh(primary["ssh_alias"], prefix + " --profile backup run --rm postgres-backup", 1800)
    except RecoveryError as exc: raise RecoveryError(f"base backup failed: {exc}") from exc
    backup_id = next((line.strip() for line in reversed(backup.stdout.splitlines())
                      if line.strip().endswith("Z") and line.strip()[:-1].replace("T", "").isdigit()), None)
    if not backup_id: raise RecoveryError("backup job did not return an immutable backup ID")
    try:
        ssh(primary["ssh_alias"], prefix +
            f" --profile restore run --rm -e CURSUS_BACKUP_ID={shlex.quote(backup_id)} postgres-restore", 900)
    except RecoveryError as exc: raise RecoveryError(f"restore preparation failed: {exc}") from exc
    name = "cursus-production-restore-verify"
    script = f"""
set -eu
image=$(docker inspect cursus-production-primary-postgres-1 --format '{{{{.Image}}}}')
test -n "$image"
docker rm -f {name} >/dev/null 2>&1 || true
cleanup() {{ docker rm -f {name} >/dev/null 2>&1 || true; }}
trap cleanup EXIT HUP INT TERM
docker run -d --name {name} --network none \
  -v /home/lab/cursus-production-data/postgres-restore-drill:/var/lib/postgresql/data \
  -v /home/lab/cursus-production-data/postgres-backups:/backup:ro \
  --tmpfs /tmp:rw,size=64m,mode=1777 "$image" \
  postgres -c listen_addresses= -c unix_socket_directories=/tmp >/dev/null
i=0
until docker exec {name} pg_isready -h /tmp -U cursus -d cursus >/dev/null 2>&1; do
  i=$((i+1)); test "$i" -lt 120; sleep 1
done
docker exec {name} test -s /var/lib/postgresql/data/PG_VERSION
docker exec {name} test -s /var/lib/postgresql/data/cursus-restore.json
result=$(docker exec {name} psql -h /tmp -U cursus -d cursus -Atc \
  "select pg_is_in_recovery(),(select timeline_id from pg_control_checkpoint()),coalesce(max(version),0) from schema_migrations")
manifest=$(docker exec {name} sha256sum /backup/base/{backup_id}/backup_manifest | cut -d' ' -f1)
printf '%s|%s\n' "$result" "$manifest"
""".strip()
    try: verified = ssh(primary["ssh_alias"], script, 900).stdout.strip().split("|")
    except RecoveryError as exc: raise RecoveryError(f"isolated restore verification failed: {exc}") from exc
    if len(verified) != 4 or verified[0] not in ("t", "f"):
        raise RecoveryError("isolated restored database verification returned an invalid result")
    return {"success": True, "nonce": nonce, "backup_id": backup_id,
            "restore_verified": True, "restored_in_recovery": verified[0] == "t",
            "database_timeline": int(verified[1]), "schema_version": int(verified[2]),
            "backup_manifest_sha256": verified[3],
            "rto_seconds": round(time.monotonic() - started, 3),
            "rpo_observation": "asynchronous replica lag is checked separately at provisioning time"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--config", default=str(ROOT / "deploy/production.json"))
    args = parser.parse_args()
    try:
        if args.stage != "recovery": raise RecoveryError("adapter supports only the recovery stage")
        print(json.dumps(verify(Path(args.config), args.nonce), sort_keys=True)); return 0
    except (RecoveryError, subprocess.TimeoutExpired, OSError, ValueError, StopIteration) as exc:
        print(f"error: {exc}", file=sys.stderr); return 2


if __name__ == "__main__": raise SystemExit(main())
