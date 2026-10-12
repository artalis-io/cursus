#!/usr/bin/env python3
"""Fence a reachable staging PostgreSQL primary through its Docker authority.

An unreachable node is not evidence of isolation: this adapter fails, causing
stateful.py to refuse promotion. Herding Sparks may replace this adapter with
an independent power/network fence using the same JSON contract.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True); parser.add_argument("--project", required=True)
    parser.add_argument("--nonce", required=True)
    args = parser.parse_args()
    inventory = json.loads((ROOT / "deploy/stateful.json").read_text())
    node = next((item for item in inventory["nodes"] if item["name"] == args.node), None)
    if not node or node["project"] != args.project or node["role"] != "primary":
        raise RuntimeError("requested fence target is not the configured staging primary")
    selector = (f"docker ps -aq --filter label=com.docker.compose.project={shlex.quote(args.project)} "
                f"--filter label=com.docker.compose.service={shlex.quote(node['postgres_service'])}")
    script = (f'cid=$({selector}); test -n "$cid"; docker update --restart=no "$cid" >/dev/null; '
              f'docker stop --time 60 "$cid" >/dev/null; '
              f'docker inspect "$cid" --format "{{{{.Id}}}} {{{{.State.Running}}}} {{{{.HostConfig.RestartPolicy.Name}}}}"')
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", node["ssh_alias"],
                             "sh -c " + shlex.quote(script)], text=True, capture_output=True, timeout=90)
    if result.returncode: raise RuntimeError("fence command or verification failed")
    fields = result.stdout.strip().split()
    if len(fields) != 3 or fields[1:] != ["false", "no"]: raise RuntimeError("old primary remains runnable")
    digest = hashlib.sha256(result.stdout.encode()).hexdigest()
    print(json.dumps({"isolated": True, "node": args.node, "nonce": args.nonce,
                      "authority": "docker-engine-via-controller", "evidence": f"sha256:{digest}",
                      "container_id": fields[0]}))
    return 0


if __name__ == "__main__":
    try: raise SystemExit(main())
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"fence failed: {exc}", file=sys.stderr); raise SystemExit(2)
