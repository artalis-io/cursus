#!/usr/bin/env python3
"""Gated production provision, migration, and two-origin Cursus cutover."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "deploy/production.json"


class CutoverError(RuntimeError): pass


def run(argv: list[str], timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise CutoverError(f"command failed ({argv[0]}): {detail[-2000:]}")
    return result


def ssh(node: dict[str, Any], command: str, timeout: int = 30,
        check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
                node["ssh_alias"], command], timeout, check)


def load(path: str | Path) -> dict[str, Any]:
    cfg = json.loads(Path(path).read_text())
    if cfg.get("approval_gates") != ["provision", "migration", "cutover"]:
        raise CutoverError("production inventory must retain all three ordered approval gates")
    nodes = cfg.get("nodes", [])
    if len(nodes) != 2 or {n["role"] for n in nodes} != {"primary", "standby"}:
        raise CutoverError("exactly one primary and one standby are required")
    if len({n["candidate_port"] for n in nodes}) != 2:
        raise CutoverError("candidate ports must be isolated per node")
    if any(n["candidate_port"] == n["active_port"] for n in nodes):
        raise CutoverError("candidate deployment must not bind the active port")
    ha_cfg = json.loads((ROOT / cfg["ha_config"]).read_text())
    if {n["ssh_alias"] for n in nodes} != {n["ssh_alias"] for n in ha_cfg["nodes"]}:
        raise CutoverError("production inventory must reuse the adopted HA nodes")
    if cfg["hostname"] != ha_cfg["hostname"]:
        raise CutoverError("production hostname differs from HA desired state")
    return cfg


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def report_path(cfg: dict[str, Any], stage: str) -> Path:
    return ROOT / cfg["evidence"]["directory"] / cfg["evidence"][stage]


def write_report(cfg: dict[str, Any], stage: str, value: dict[str, Any]) -> Path:
    path = report_path(cfg, stage)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    return path


def read_evidence(cfg: dict[str, Any], stage: str) -> dict[str, Any]:
    path = report_path(cfg, stage)
    try: value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise CutoverError(f"missing or invalid {stage} evidence: {path}") from exc
    if value.get("stage") != stage or value.get("success") is not True:
        raise CutoverError(f"{stage} evidence does not record a successful gate")
    return value


def validate(cfg: dict[str, Any]) -> dict[str, Any]:
    compose = ROOT / cfg["compose_file"]
    example = ROOT / ".env.production.example"
    if not compose.exists() or not example.exists():
        raise CutoverError("production Compose contract or environment example is missing")
    text = compose.read_text()
    for forbidden in ("network_mode: host", "privileged:", "/var/run/docker.sock"):
        if forbidden in text: raise CutoverError(f"forbidden Compose setting: {forbidden}")
    return {"valid": True, "compose_sha256": digest(compose),
            "environment_sha256": digest(example), "nodes": cfg["nodes"]}


def remote_inventory(node: dict[str, Any]) -> dict[str, Any]:
    # The command emits no environment variables, credentials, dataset names,
    # or process arguments other than the allow-listed temporary server.
    script = """
set -eu
printf 'arch='; uname -m
printf 'docker='; docker version --format '{{.Server.Version}}'
printf 'compose='; docker compose version --short
printf 'disk_kb='; df -Pk /home/lab | awk 'NR==2 {print $4}'
printf 'memory_kb='; awk '/MemTotal/ {print $2}' /proc/meminfo
printf 'port8080='; if curl -fsS --max-time 5 http://127.0.0.1:8080/health/ready >/dev/null; then echo ready; else echo unavailable; fi
printf 'hello_pids='; pgrep -f '^python3 /tmp/cursus-hello.py$' | paste -sd, - || true
printf 'cloudflared='; systemctl is-active cloudflared.service 2>/dev/null || true
""".strip()
    result = ssh(node, script)
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    return {"name": node["name"], "ssh_alias": node["ssh_alias"], **values}


def preflight(cfg: dict[str, Any]) -> dict[str, Any]:
    nodes = [remote_inventory(node) for node in cfg["nodes"]]
    for node in nodes:
        if node.get("arch") != "aarch64": raise CutoverError(f"{node['name']}: expected native ARM64")
        if node.get("port8080") != "ready": raise CutoverError(f"{node['name']}: current production readiness failed")
        if not node.get("hello_pids"): raise CutoverError(f"{node['name']}: temporary Hello World process not identified")
        if node.get("cloudflared") != "active": raise CutoverError(f"{node['name']}: Cloudflare connector is not active")
    secret_files = [Path.home() / ".config/cursus" / name for name in
                    ("production-r2-access-key-id", "production-r2-secret-access-key",
                     "production-r2-bucket", "resend-api-key", "auth-allowlist")]
    secrets = []
    for path in secret_files:
        present = path.is_file()
        mode = path.stat().st_mode & 0o777 if present else None
        secrets.append({"name": path.name, "present": present, "mode": oct(mode) if mode is not None else None,
                        "secure": present and mode & 0o077 == 0})
    if not all(item["secure"] for item in secrets):
        raise CutoverError("controller credential files must exist with no group/other permissions")
    return {"schema_version": 1, "stage": "preflight", "created_at": now(),
            "validation": validate(cfg), "nodes": nodes, "controller_secret_files": secrets,
            "mutations": []}


def compose(node: dict[str, Any], profiles: list[str], operation: str,
            port: int | None = None, timeout: int = 900) -> subprocess.CompletedProcess[str]:
    profile_args = " ".join(f"--profile {shlex.quote(profile)}" for profile in profiles)
    override = f"CURSUS_STAGING_PORT={port} " if port is not None else ""
    command = (f"cd {shlex.quote(node['deployment_dir'])} && {override}"
               f"docker compose --env-file {shlex.quote(node['env_file'])} "
               f"-f {shlex.quote('compose.stateful.yaml')} {profile_args} {operation}")
    return ssh(node, command, timeout=timeout)


def candidate_status(node: dict[str, Any]) -> dict[str, Any]:
    ready = ssh(node, f"curl -fsS --max-time 10 http://127.0.0.1:{node['candidate_port']}/health/ready", check=False)
    selector = ("cid=$(docker ps -q --filter " +
                shlex.quote(f"label=com.docker.compose.project={node['project']}") + " --filter " +
                shlex.quote("label=com.docker.compose.service=cursus") + "); "
                "test -n \"$cid\" && docker inspect \"$cid\" --format '{{.Image}}'")
    image = ssh(node, selector, check=False)
    db_selector = ("cid=$(docker ps -q --filter " +
                   shlex.quote(f"label=com.docker.compose.project={node['project']}") + " --filter " +
                   shlex.quote(f"label=com.docker.compose.service={node['postgres_service']}") + "); "
                   "test -n \"$cid\" && docker exec \"$cid\" psql -U cursus -d cursus -Atc " +
                   shlex.quote("select pg_is_in_recovery(),case when pg_is_in_recovery() then 0 "
                               "else (select count(*) from pg_stat_replication) end,"
                               "case when pg_is_in_recovery() then null else coalesce((select "
                               "max(pg_wal_lsn_diff(pg_current_wal_lsn(),replay_lsn))::bigint "
                               "from pg_stat_replication),-1) end"))
    database = ssh(node, db_selector, check=False)
    fields = database.stdout.strip().split("|", 2)
    db = None if database.returncode or len(fields) != 3 else {
        "in_recovery": fields[0] == "t", "connected_standbys": int(fields[1]),
        "replication_lag_bytes": int(fields[2]) if fields[2] else None}
    return {"node": node["name"], "role": node["role"], "ready": ready.returncode == 0,
            "readiness": ready.stdout.strip()[:500], "image_id": image.stdout.strip() or None,
            "database": db}


def provision(cfg: dict[str, Any], approved: bool, recovery_adapter: str | None) -> dict[str, Any]:
    if not approved: raise CutoverError("provision requires --approve-provision")
    if not recovery_adapter:
        raise CutoverError("provision requires --recovery-adapter for backup/restore proof")
    # Configuration and secret files are operator-installed, avoiding secret
    # transfer through command output or this repository.
    for node in cfg["nodes"]:
        check = (f"cd {shlex.quote(node['deployment_dir'])} && test -f {shlex.quote(node['env_file'])} && "
                 "test $(stat -c %a " + shlex.quote(node["env_file"]) + ") = 600 && "
                 "docker compose --env-file " + shlex.quote(node["env_file"]) +
                 " -f compose.stateful.yaml config --quiet")
        ssh(node, check, timeout=60)
    primary = next(n for n in cfg["nodes"] if n["role"] == "primary")
    standby = next(n for n in cfg["nodes"] if n["role"] == "standby")
    compose(primary, ["database-primary"], "up -d --no-build --pull never", primary["candidate_port"])
    compose(standby, ["database-standby"], "up -d --no-build --pull never", standby["candidate_port"])
    statuses = [candidate_status(node) for node in cfg["nodes"]]
    if not all(item["ready"] and item["image_id"] for item in statuses):
        raise CutoverError("production candidates did not both become ready")
    if len({item["image_id"] for item in statuses}) != 1:
        raise CutoverError("production candidates do not use the same image ID")
    primary_status = next(item for item in statuses if item["role"] == "primary")
    standby_status = next(item for item in statuses if item["role"] == "standby")
    if (not primary_status["database"] or primary_status["database"]["in_recovery"] or
            primary_status["database"]["connected_standbys"] != 1 or
            primary_status["database"]["replication_lag_bytes"] != 0 or
            not standby_status["database"] or not standby_status["database"]["in_recovery"]):
        raise CutoverError("PostgreSQL role/replication prerequisite failed")
    recovery = invoke_adapter(recovery_adapter, "recovery")
    if not recovery.get("backup_id") or recovery.get("restore_verified") is not True:
        raise CutoverError("recovery adapter did not prove a recoverable backup and isolated restore")
    scheduled_recovery = recovery_jobs(cfg, 'install', approved=True)
    evidence = {"schema_version": 1, "stage": "provision", "success": True,
                "created_at": now(), "nodes": statuses, "recovery": recovery,
                "public_traffic_changed": False, "scheduled_recovery": scheduled_recovery}
    write_report(cfg, "provision", evidence)
    return evidence


def invoke_adapter(command: str, stage: str) -> dict[str, Any]:
    nonce = os.urandom(24).hex()
    result = run(shlex.split(command) + ["--stage", stage, "--nonce", nonce], timeout=7200)
    try: value = json.loads(result.stdout)
    except json.JSONDecodeError as exc: raise CutoverError(f"{stage} adapter did not return JSON") from exc
    if value.get("success") is not True or value.get("nonce") != nonce:
        raise CutoverError(f"{stage} adapter did not return matching successful evidence")
    return value


def migrate(cfg: dict[str, Any], approved: bool, freeze_evidence: Path | None,
            adapter: str | None) -> dict[str, Any]:
    if not approved: raise CutoverError("migration requires --approve-migration")
    read_evidence(cfg, "provision")
    if not freeze_evidence or not adapter:
        raise CutoverError("migration requires --freeze-evidence and --adapter")
    try: freeze = json.loads(freeze_evidence.read_text())
    except (OSError, json.JSONDecodeError) as exc: raise CutoverError("write-freeze evidence is missing or invalid") from exc
    if freeze.get("frozen") is not True or not freeze.get("authority") or not freeze.get("snapshot"):
        raise CutoverError("write-freeze evidence must identify authority and immutable snapshot")
    outcome = invoke_adapter(adapter, "migration")
    evidence = {"schema_version": 1, "stage": "migration", "success": True,
                "created_at": now(), "freeze": freeze, "adapter": outcome,
                "public_traffic_changed": False}
    write_report(cfg, "migration", evidence)
    return evidence


def load_ha(cfg: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    path = ROOT / "deploy/ha.py"
    spec = importlib.util.spec_from_file_location("cursus_ha_cutover", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module, module.load_config(ROOT / cfg["ha_config"])


def hello_command(cfg: dict[str, Any]) -> str:
    return " ".join(shlex.quote(part) for part in cfg["temporary_service"]["command"])


def stop_hello(node: dict[str, Any], cfg: dict[str, Any]) -> None:
    expected = hello_command(cfg)
    script = ("set -eu; pids=$(pgrep -f " + shlex.quote("^" + expected + "$") + "); "
              "test $(printf '%s\\n' \"$pids\" | wc -l) -eq 1; pid=$pids; "
              "actual=$(tr '\\0' ' ' </proc/$pid/cmdline); "
              "test \"$actual\" = " + shlex.quote(expected + " ") + "; kill -TERM $pid; "
              "i=0; while kill -0 $pid 2>/dev/null; do i=$((i+1)); test $i -lt 50; sleep .2; done")
    ssh(node, script, timeout=20)


def start_hello(node: dict[str, Any], cfg: dict[str, Any]) -> None:
    command = hello_command(cfg)
    # Group only the nohup branch. Without braces, `&` backgrounds the whole
    # OR-list and can keep the SSH session open until its timeout.
    script = (f"pgrep -f {shlex.quote('^' + command + '$')} >/dev/null || {{ "
              f"nohup {command} >/tmp/cursus-hello.log 2>&1 </dev/null & }}")
    ssh(node, script)


def set_app_port(node: dict[str, Any], port: int) -> None:
    env_file = shlex.quote(node["env_file"])
    command = (f"cd {shlex.quote(node['deployment_dir'])} && "
               f"test $(grep -c '^CURSUS_STAGING_PORT=' {env_file}) -eq 1 && "
               f"sed -i.bak -E 's/^CURSUS_STAGING_PORT=.*/CURSUS_STAGING_PORT={port}/' {env_file} && "
               f"test $(grep -c '^CURSUS_STAGING_PORT={port}$' {env_file}) -eq 1")
    ssh(node, command)


def activate_node(node: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    stop_hello(node, cfg)
    try:
        set_app_port(node, node["active_port"])
        compose(node, ["database-primary" if node["role"] == "primary" else "database-standby"],
                "up -d --no-deps --pull never cursus", timeout=180)
        ready = ssh(node, f"curl -fsS --max-time 15 http://127.0.0.1:{node['active_port']}/health/ready")
        ssh(node, f"curl -fsS -o /dev/null --max-time 15 http://127.0.0.1:{node['active_port']}/")
        return {"node": node["name"], "ready": json.loads(ready.stdout)}
    except Exception:
        compose(node, [], "rm -sf cursus", node["active_port"], timeout=60)
        set_app_port(node, node["candidate_port"])
        compose(node, [], "up -d --no-deps --pull never cursus", timeout=180)
        start_hello(node, cfg)
        raise


def rollback_node(node: dict[str, Any], cfg: dict[str, Any]) -> None:
    compose(node, [], "rm -sf cursus", node["active_port"], timeout=60)
    set_app_port(node, node["candidate_port"])
    compose(node, [], "up -d --no-deps --pull never cursus", node["candidate_port"], timeout=180)
    start_hello(node, cfg)
    ssh(node, f"curl -fsS --max-time 15 http://127.0.0.1:{node['candidate_port']}/health/ready")
    ssh(node, f"curl -fsS --max-time 15 http://127.0.0.1:{node['active_port']}/health/ready")


def wait_origin_healthy(ha: Any, client: Any, ha_cfg: dict[str, Any], node_name: str,
                        timeout: int = 180) -> None:
    index = next(i for i, node in enumerate(ha_cfg["nodes"]) if node["name"] == node_name)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        health = ha.fetch_state(client, ha_cfg, health=True)["nodes"][index]["health"].get("pop_health", {})
        if health and all(item.get("healthy") for item in health.values()): return
        time.sleep(5)
    raise CutoverError(f"{node_name} did not become healthy in every Cloudflare monitor location")


def activate(cfg: dict[str, Any], approved: bool, acceptance_report: Path | None = None) -> dict[str, Any]:
    if not approved: raise CutoverError("cutover requires --approve-cutover")
    provisioned, migrated = read_evidence(cfg, "provision"), read_evidence(cfg, "migration")
    statuses = [candidate_status(node) for node in cfg["nodes"]]
    if not all(item["ready"] for item in statuses) or len({item["image_id"] for item in statuses}) != 1:
        raise CutoverError("candidate readiness/image prerequisite failed")
    if provisioned["nodes"][0]["image_id"] != statuses[0]["image_id"]:
        raise CutoverError("candidate image changed after provisioning evidence")
    spec = importlib.util.spec_from_file_location('cursus_release_gate', ROOT / 'deploy/stateful.py')
    gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)
    try: gate.acceptance_evidence(acceptance_report, statuses[0]['image_id'])
    except gate.DeploymentError as exc: raise CutoverError(str(exc)) from exc
    ha, ha_cfg = load_ha(cfg)
    client = ha.Cloudflare(ha.token())
    if ha.build_plan(ha_cfg, ha.fetch_state(client, ha_cfg)):
        raise CutoverError("Cloudflare desired state has drift; refusing cutover")
    results = []
    # Secondary first. Each origin is explicitly drained and always restored;
    # the other ready origin remains in service throughout.
    for node in sorted(cfg["nodes"], key=lambda item: item["role"] != "standby"):
        ha_node = next(item for item in ha_cfg["nodes"] if item["ssh_alias"] == node["ssh_alias"])
        recovery_jobs(cfg, 'pause', approved=True, node=node['name'])
        ha.set_origin_enabled(client, ha_cfg, ha_node["name"], False, True)
        activated = False
        try:
            results.append(activate_node(node, cfg))
            activated = True
            ha.set_origin_enabled(client, ha_cfg, ha_node["name"], True, True)
            wait_origin_healthy(ha, client, ha_cfg, ha_node["name"])
            recovery_jobs(cfg, 'resume', approved=True, node=node['name'])
        except Exception:
            try:
                ha.set_origin_enabled(client, ha_cfg, ha_node["name"], False, True)
                if activated: rollback_node(node, cfg)
            finally:
                ha.set_origin_enabled(client, ha_cfg, ha_node["name"], True, True)
            raise
    public = run(["curl", "--silent", "--show-error", "--fail", "--max-time", "15",
                  f"https://{cfg['hostname']}/health/ready"])
    run(["curl", "--silent", "--show-error", "--fail", "--output", "/dev/null", "--max-time", "15",
         f"https://{cfg['hostname']}/"])
    evidence = {"schema_version": 1, "stage": "cutover", "success": True,
                "acceptance_report_sha256": digest(acceptance_report),
                "created_at": now(), "nodes": results, "image_id": statuses[0]["image_id"],
                "migration_created_at": migrated["created_at"], "public_readiness": public.stdout.strip()[:500]}
    write_report(cfg, "cutover", evidence)
    return evidence


def recovery_jobs(cfg, action, approved=False, node='all'):
    spec = importlib.util.spec_from_file_location('cursus_recovery_jobs', ROOT / 'deploy/recovery.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    try:
        return module.manage(cfg, action, approved, node)
    except module.RecoveryError as error:
        raise CutoverError(str(error)) from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate"); sub.add_parser("preflight")
    provision_parser = sub.add_parser("provision")
    provision_parser.add_argument("--approve-provision", action="store_true")
    provision_parser.add_argument("--recovery-adapter")
    migration_parser = sub.add_parser("migrate")
    migration_parser.add_argument("--approve-migration", action="store_true")
    migration_parser.add_argument("--freeze-evidence", type=Path)
    migration_parser.add_argument("--adapter")
    cutover_parser = sub.add_parser("activate")
    cutover_parser.add_argument("--approve-cutover", action="store_true")
    cutover_parser.add_argument("--acceptance-report", required=True, type=Path)
    recovery_parser = sub.add_parser('recovery', help='manage reboot-recovery jobs in the existing production inventory')
    recovery_parser.add_argument('action', choices=['install', 'status', 'pause', 'resume', 'uninstall'])
    recovery_parser.add_argument('--approve', action='store_true')
    recovery_parser.add_argument('--node', default='all', help='inventory node name, or all')
    args = parser.parse_args(argv)
    try:
        cfg = load(args.config)
        if args.command == "validate": result = validate(cfg)
        elif args.command == "preflight": result = preflight(cfg)
        elif args.command == "provision": result = provision(cfg, args.approve_provision, args.recovery_adapter)
        elif args.command == "migrate": result = migrate(cfg, args.approve_migration, args.freeze_evidence, args.adapter)
        elif args.command == 'recovery': result = recovery_jobs(cfg, args.action, args.approve, args.node)
        else: result = activate(cfg, args.approve_cutover, args.acceptance_report)
        print(json.dumps(result, indent=2, sort_keys=True))
        if args.command == 'recovery' and args.action == 'status' and not all(
                n['installed'] and n['checksums_valid'] and n['version_current'] and not n.get('uncertain_operation') for n in result['nodes']):
            return 2
        return 0
    except (CutoverError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr); return 2


if __name__ == "__main__": raise SystemExit(main())
