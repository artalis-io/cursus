#!/usr/bin/env python3
"""Fail-closed controller for isolated Cursus stateful staging."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "deploy/stateful.json"


class DeploymentError(RuntimeError): pass


def run(argv: list[str], timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        raise DeploymentError(f"command failed ({argv[0]}): {result.stderr.strip() or result.stdout.strip()}")
    return result


def load(path: str | Path) -> dict[str, Any]:
    cfg = json.loads(Path(path).read_text())
    guard = cfg["production_guard"]
    if len(cfg.get("nodes", [])) != 2: raise DeploymentError("exactly two staging nodes are required")
    for node in cfg["nodes"]:
        if node["app_port"] == guard["forbidden_port"]: raise DeploymentError("staging may not use production port 8080")
        if node["project"] == guard["forbidden_project"]: raise DeploymentError("staging may not use the production project")
        if guard["required_name_fragment"] not in node["project"]: raise DeploymentError("staging project name lacks safety marker")
    if len({n["app_port"] for n in cfg["nodes"]}) != 2: raise DeploymentError("staging app ports must be distinct")
    return cfg


def ssh(node: dict[str, Any], remote: list[str], timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess[str]:
    command = " ".join(shlex.quote(part) for part in remote)
    return run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", node["ssh_alias"], command], timeout, check)


def node_status(node: dict[str, Any]) -> dict[str, Any]:
    probe = ssh(node, ["true"], check=False)
    status: dict[str, Any] = {"name": node["name"], "role": node["role"], "ssh_ok": probe.returncode == 0}
    if probe.returncode:
        status["error"] = probe.stderr[-2000:]
        return status
    project_filter = f"label=com.docker.compose.project={node['project']}"
    containers = ssh(node, ["docker", "ps", "--filter", project_filter, "--format", "{{json .}}"], check=False)
    status["containers"] = []
    for line in containers.stdout.splitlines():
        if not line.strip(): continue
        raw = json.loads(line)
        labels = dict(part.split("=", 1) for part in raw.get("Labels", "").split(",") if "=" in part)
        status["containers"].append({"name": raw.get("Names"), "service": labels.get("com.docker.compose.service"),
                                     "image": raw.get("Image"), "image_id": labels.get("com.docker.compose.image"),
                                     "state": raw.get("State"), "status": raw.get("Status"),
                                     "ports": raw.get("Ports", ""), "networks": raw.get("Networks", "")})
    health = ssh(node, ["curl", "--silent", "--show-error", "--fail", "--max-time", "5",
                        f"http://127.0.0.1:{node['app_port']}/health/ready"], check=False)
    try: status["readiness"] = json.loads(health.stdout) if health.returncode == 0 else None
    except json.JSONDecodeError: status["readiness"] = None
    ids = ssh(node, ["docker", "ps", "-q", "--filter", project_filter], check=False).stdout.split()
    if ids:
        stats = ssh(node, ["docker", "stats", "--no-stream", "--format", "{{json .}}", *ids], check=False)
        status["resources"] = [json.loads(line) for line in stats.stdout.splitlines() if line.strip()]
    else: status["resources"] = []
    production = ssh(node, ["sh", "-c", "ss -ltn 'sport = :8080' 2>/dev/null || true"], check=False)
    status["production_port_guard"] = {
        "port": 8080,
        "listening": len(production.stdout.splitlines()) > 1,
        "snapshot_sha256": hashlib.sha256(production.stdout.encode()).hexdigest(),
    }
    selector = (f"cid=$(docker ps -q --filter label=com.docker.compose.project={shlex.quote(node['project'])} "
                f"--filter label=com.docker.compose.service={shlex.quote(node['postgres_service'])}); "
                "test -n \"$cid\" && docker exec \"$cid\" psql -U cursus -d cursus -Atc "
                + shlex.quote("select coalesce(max(version),0),pg_is_in_recovery(),case when pg_is_in_recovery() "
                              "then pg_last_wal_replay_lsn() else pg_current_wal_lsn() end," 
                              "(select timeline_id from pg_control_checkpoint()) from schema_migrations"))
    database = ssh(node, ["sh", "-c", selector], check=False)
    if database.returncode == 0 and database.stdout.strip():
        schema, recovery, lsn, timeline = database.stdout.strip().split("|", 3)
        status["database"] = {"schema_version": int(schema), "in_recovery": recovery == "t",
                              "wal_lsn": lsn, "timeline": int(timeline)}
    else: status["database"] = None
    return status


def command_validate(cfg: dict[str, Any]) -> dict[str, Any]:
    compose = ROOT / cfg["compose_file"]
    if not compose.exists(): raise DeploymentError(f"missing compose file: {compose}")
    ha = json.loads((ROOT / "deploy/ha.json").read_text())
    ha_aliases = {n["ssh_alias"] for n in ha["nodes"]}
    aliases = {n["ssh_alias"] for n in cfg["nodes"]}
    if aliases != ha_aliases: raise DeploymentError("stateful inventory must reuse deploy/ha.json node inventory")
    text = compose.read_text()
    for forbidden in ("network_mode: host", "privileged:", "/var/run/docker.sock", "127.0.0.1:8080"):
        if forbidden in text: raise DeploymentError(f"forbidden Compose setting: {forbidden}")
    return {"valid": True, "compose_sha256": hashlib.sha256(compose.read_bytes()).hexdigest(), "nodes": cfg["nodes"]}


def update_application(cfg: dict[str, Any], image: str, approved: bool, action: str) -> dict[str, Any]:
    """Update only the isolated staging application, secondary first."""
    if not approved: raise DeploymentError(f"{action} requires --approve")
    if not image or any(char.isspace() for char in image): raise DeploymentError("a single explicit image reference is required")
    ordered = sorted(cfg["nodes"], key=lambda node: node["role"] != "standby")
    results = []
    for node in ordered:
        # Refuse an image that is absent or incompatible before touching Compose.
        inspect = ssh(node, ["docker", "image", "inspect", image, "--format",
                             "{{index .Config.Labels \"io.artalis.cursus.schema.minimum\"}}|"
                             "{{index .Config.Labels \"io.artalis.cursus.schema.maximum\"}}|{{.Id}}"])
        fields = inspect.stdout.strip().split("|", 2)
        if len(fields) != 3 or fields[0] != "1" or fields[1] != "1":
            raise DeploymentError(f"{node['name']}: image does not declare schema compatibility 1..1")
        remote = (
            f"cd {shlex.quote(node['deployment_dir'])} && "
            f"CURSUS_APP_IMAGE={shlex.quote(image)} docker compose --env-file {shlex.quote(node['env_file'])} "
            "-f compose.stateful.yaml up -d --no-deps --pull never cursus"
        )
        ssh(node, ["sh", "-c", remote], timeout=180)
        ready = ssh(node, ["curl", "--silent", "--show-error", "--fail", "--max-time", "10",
                           f"http://127.0.0.1:{node['app_port']}/health/ready"], timeout=20)
        results.append({"node": node["name"], "role": node["role"], "image": image,
                        "image_id": fields[2], "ready": json.loads(ready.stdout)})
    return {"schema_version": 1, "action": action, "image": image, "nodes": results}


def fence(command: str, old: dict[str, Any], nonce: str) -> dict[str, Any]:
    # The adapter is controlled by Herding Sparks or another independent
    # authority. Network failure/SSH failure is never interpreted as isolation.
    result = run(shlex.split(command) + ["--node", old["name"], "--project", old["project"], "--nonce", nonce], timeout=120)
    try: evidence = json.loads(result.stdout)
    except json.JSONDecodeError as exc: raise DeploymentError("fence adapter did not return JSON") from exc
    if evidence.get("isolated") is not True or evidence.get("node") != old["name"] or evidence.get("nonce") != nonce:
        raise DeploymentError("fence adapter did not prove isolation for this request")
    if not evidence.get("authority") or not evidence.get("evidence"):
        raise DeploymentError("fence evidence lacks authority or durable evidence reference")
    return evidence


def promote(cfg: dict[str, Any], approved: bool, fence_command: str | None, report_path: Path) -> dict[str, Any]:
    if not approved: raise DeploymentError("promotion requires --approve")
    if not fence_command: raise DeploymentError("promotion requires CURSUS_FENCE_COMMAND or --fence-command")
    old = next(n for n in cfg["nodes"] if n["role"] == "primary")
    standby = next(n for n in cfg["nodes"] if n["role"] == "standby")
    nonce = os.urandom(24).hex()
    evidence = fence(fence_command, old, nonce)
    service = standby["postgres_service"]
    selector = (f"docker ps -q --filter label=com.docker.compose.project={shlex.quote(standby['project'])} "
                f"--filter label=com.docker.compose.service={shlex.quote(service)}")
    promote_script = f'cid=$({selector}); test -n "$cid"; docker exec -u postgres "$cid" pg_ctl promote -D /var/lib/postgresql/data'
    ssh(standby, ["sh", "-c", promote_script], timeout=60)
    verify_script = (f'cid=$({selector}); test -n "$cid"; docker exec "$cid" psql -U cursus -d cursus -Atc '
                     + shlex.quote("select pg_is_in_recovery(),pg_current_wal_lsn()"))
    verify = ssh(standby, ["sh", "-c", verify_script], timeout=30)
    if not verify.stdout.strip().startswith("f|"): raise DeploymentError("standby promotion verification failed")
    report = {"schema_version": 1, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "action": "manual-promotion", "old_primary": old["name"], "new_primary": standby["name"],
              "fencing": evidence, "database": {"verification": verify.stdout.strip()}}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate")
    sub.add_parser("status")
    report_parser = sub.add_parser("report"); report_parser.add_argument("--output", required=True)
    for name in ("rollout", "rollback"):
        operation = sub.add_parser(name)
        operation.add_argument("--image", required=True)
        operation.add_argument("--approve", action="store_true")
    promote_parser = sub.add_parser("promote"); promote_parser.add_argument("--approve", action="store_true")
    promote_parser.add_argument("--fence-command"); promote_parser.add_argument("--report", required=True)
    args = parser.parse_args(); cfg = load(args.config)
    if args.command == "validate": result = command_validate(cfg)
    elif args.command == "status": result = {"nodes": [node_status(n) for n in cfg["nodes"]]}
    elif args.command == "report":
        result = {"schema_version": 1, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                  "source_revision": run(["git", "rev-parse", "HEAD"]).stdout.strip(),
                  "otto_revision": run(["git", "-C", str(ROOT / "vendor/otto"), "rev-parse", "HEAD"]).stdout.strip(),
                  "validation": command_validate(cfg), "nodes": [node_status(n) for n in cfg["nodes"]]}
        Path(args.output).write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    elif args.command in ("rollout", "rollback"):
        result = update_application(cfg, args.image, args.approve, args.command)
    else: result = promote(cfg, args.approve, args.fence_command or os.environ.get("CURSUS_FENCE_COMMAND"), Path(args.report))
    print(json.dumps(result, indent=2, sort_keys=True)); return 0


if __name__ == "__main__":
    try: raise SystemExit(main())
    except (DeploymentError, subprocess.TimeoutExpired) as exc: print(f"error: {exc}", file=sys.stderr); raise SystemExit(2)
