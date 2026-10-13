#!/usr/bin/env python3
"""Adopt and reconcile Cursus-owned fields in the existing Cloudflare HA stack."""
from __future__ import annotations

import argparse
import copy
import json
import os
import shlex
import signal
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

API = "https://api.cloudflare.com/client/v4"
ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "ha.json"
LB_FIELDS = ("enabled", "proxied", "steering_policy", "default_pools", "fallback_pool", "session_affinity")
MONITOR_FIELDS = ("type", "port", "method", "path", "header", "expected_codes", "expected_body", "interval", "timeout", "retries", "consecutive_down", "consecutive_up")
POOL_FIELDS = ("name", "enabled", "minimum_origins", "monitor", "origins")
ORIGIN_FIELDS = ("name", "address", "enabled", "weight", "header")


class HAError(RuntimeError): pass
class APIError(HAError): pass


def token() -> str:
    value = os.environ.get("CF_API_TOKEN", "").strip()
    path = Path.home() / ".config/cloudflare/api-token"
    if not value and path.exists():
        if path.stat().st_mode & 0o077:
            raise HAError(f"Cloudflare token file must be mode 0600: {path}")
        value = path.read_text().strip()
    if not value:
        raise HAError("set CF_API_TOKEN or create ~/.config/cloudflare/api-token (mode 0600)")
    return value


class Cloudflare:
    def __init__(self, api_token: str, base: str = API, timeout: float = 15, opener: Any = None):
        self._token, self.base, self.timeout = api_token, base.rstrip("/"), timeout
        self.opener = opener or urllib.request.build_opener(urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
            headers={"Authorization": "Bearer " + self._token, "Content-Type": "application/json", "User-Agent": "cursus-ha/1"})
        attempts = 3 if method == "GET" else 1
        for attempt in range(attempts):
            try:
                with self.opener.open(req, timeout=self.timeout) as response:
                    payload = json.loads(response.read())
                if not payload.get("success"):
                    raise APIError(self.redact(self._errors(payload)))
                return payload.get("result")
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode(errors="replace")[:2000]
                message = self.redact(f"Cloudflare {method} {path}: HTTP {exc.code}: {raw}")
                if method == "GET" and exc.code in (429, 500, 502, 503, 504) and attempt + 1 < attempts:
                    time.sleep(2 ** attempt); continue
                raise APIError(message) from None
            except (urllib.error.URLError, TimeoutError) as exc:
                if method == "GET" and attempt + 1 < attempts:
                    time.sleep(2 ** attempt); continue
                raise APIError(self.redact(f"Cloudflare {method} {path}: {exc}")) from None
        raise APIError("unreachable")

    @staticmethod
    def _errors(payload: dict[str, Any]) -> str:
        return "; ".join(str(e.get("message", "API failure")) for e in payload.get("errors", [])) or "Cloudflare API failure"

    def redact(self, value: str) -> str: return value.replace(self._token, "[REDACTED]")

    def get(self, path: str) -> Any: return self.request("GET", path)
    def patch(self, path: str, body: dict[str, Any]) -> Any: return self.request("PATCH", path, body)
    def put(self, path: str, body: dict[str, Any]) -> Any: return self.request("PUT", path, body)

    def pages(self, path: str) -> list[Any]:
        # Kept generic for inventory/status operations without assuming one page.
        result, page = [], 1
        while True:
            separator = "&" if "?" in path else "?"
            payload = self.get(f"{path}{separator}page={page}&per_page=50")
            if not isinstance(payload, list): return [payload]
            result.extend(payload)
            if len(payload) < 50: return result
            page += 1


def load_config(path: str | Path) -> dict[str, Any]:
    data = json.loads(Path(path).read_text())
    required = ("account_id", "zone_id", "hostname", "load_balancer", "monitor", "nodes")
    missing = [key for key in required if key not in data]
    if missing: raise HAError("desired-state config missing: " + ", ".join(missing))
    if len(data["nodes"]) != 2: raise HAError("exactly two HA nodes are required")
    addresses = [n["pool"]["origin"]["address"] for n in data["nodes"]]
    if len(addresses) > data.get("origin_quota", 2) or len(set(addresses)) != len(addresses):
        raise HAError("desired state violates the two-origin quota or duplicates an origin")
    return data


def select(value: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {key: value.get(key) for key in fields}


def desired_pool(cfg: dict[str, Any], node: dict[str, Any]) -> dict[str, Any]:
    p = node["pool"]
    return {"name": p["name"], "enabled": p["enabled"], "minimum_origins": p["minimum_origins"],
            "monitor": cfg["monitor"]["id"], "origins": [select(p["origin"], ORIGIN_FIELDS)]}


def normalize_pool(pool: dict[str, Any]) -> dict[str, Any]:
    value = select(pool, POOL_FIELDS)
    value["origins"] = [select(o, ORIGIN_FIELDS) for o in pool.get("origins", [])]
    return value


def merge_ingress(config: dict[str, Any], hostname: str, service: str) -> tuple[dict[str, Any], bool]:
    """Replace only this hostname's ingress; preserve order, catch-all and unknown fields."""
    merged = copy.deepcopy(config)
    ingress = merged.get("ingress")
    if not isinstance(ingress, list): raise HAError("tunnel config has no ingress list")
    indexes = [i for i, rule in enumerate(ingress) if rule.get("hostname") == hostname]
    desired = {"hostname": hostname, "service": service}
    if len(indexes) == 1 and ingress[indexes[0]] == desired: return merged, False
    insertion = indexes[0] if indexes else max(0, len(ingress) - 1)
    kept = [rule for rule in ingress if rule.get("hostname") != hostname]
    kept.insert(min(insertion, len(kept)), desired)
    merged["ingress"] = kept
    return merged, True


def paths(cfg: dict[str, Any]) -> dict[str, str]:
    account, zone = cfg["account_id"], cfg["zone_id"]
    return {
        "verify": f"/accounts/{account}/tokens/verify",
        "lb": f"/zones/{zone}/load_balancers/{cfg['load_balancer']['id']}",
        "monitor": f"/accounts/{account}/load_balancers/monitors/{cfg['monitor']['id']}",
    }


def fetch_state(client: Any, cfg: dict[str, Any], health: bool = False) -> dict[str, Any]:
    p = paths(cfg)
    verification = client.get(p["verify"])
    if verification.get("status") != "active": raise HAError("Cloudflare account token is not active")
    state = {"lb": client.get(p["lb"]), "monitor": client.get(p["monitor"]), "nodes": []}
    for node in cfg["nodes"]:
        pool_path = f"/accounts/{cfg['account_id']}/load_balancers/pools/{node['pool']['id']}"
        tunnel_path = f"/accounts/{cfg['account_id']}/cfd_tunnel/{node['tunnel_id']}"
        item = {"pool": client.get(pool_path), "tunnel": client.get(tunnel_path),
                "tunnel_config": client.get(tunnel_path + "/configurations").get("config", {})}
        if health: item["health"] = client.get(pool_path + "/health")
        state["nodes"].append(item)
    return state


def build_plan(cfg: dict[str, Any], state: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    desired_lb = select(cfg["load_balancer"], LB_FIELDS)
    live_lb = select(state["lb"], LB_FIELDS)
    if live_lb != desired_lb: changes.append({"resource": "load_balancer", "current": live_lb, "desired": desired_lb, "unsafe": True})
    desired_monitor = select(cfg["monitor"], MONITOR_FIELDS)
    live_monitor = select(state["monitor"], MONITOR_FIELDS)
    if live_monitor != desired_monitor: changes.append({"resource": "monitor", "current": live_monitor, "desired": desired_monitor, "unsafe": True})
    for node, live in zip(cfg["nodes"], state["nodes"]):
        dp, lp = desired_pool(cfg, node), normalize_pool(live["pool"])
        if lp != dp: changes.append({"resource": f"pool:{node['name']}", "current": lp, "desired": dp, "unsafe": True})
        merged, changed = merge_ingress(live["tunnel_config"], cfg["hostname"], node["service"])
        if changed: changes.append({"resource": f"tunnel:{node['name']}", "current": live["tunnel_config"], "desired": merged, "unsafe": True})
    return changes


def print_plan(changes: list[dict[str, Any]]) -> None:
    if not changes: print("Converged: no Cursus-owned drift detected."); return
    print(f"Drift: {len(changes)} production-impacting change(s) proposed:")
    for change in changes:
        print(f"- {change['resource']} [UNSAFE: explicit apply approval required]")
        print("  current: " + json.dumps(change["current"], sort_keys=True))
        print("  desired: " + json.dumps(change["desired"], sort_keys=True))


def apply(client: Any, cfg: dict[str, Any], approved: bool) -> None:
    if not approved: raise HAError("apply requires --approve; no changes were made")
    before = fetch_state(client, cfg)
    changes = build_plan(cfg, before)
    if not changes: print("Converged: nothing to apply."); return
    # A fresh full read immediately before writes narrows the stale-plan window.
    fresh = fetch_state(client, cfg)
    if build_plan(cfg, fresh) != changes: raise HAError("live state changed during approval window; re-run plan")
    total_origins = sum(len(n["pool"].get("origins", [])) for n in fresh["nodes"])
    if total_origins > cfg.get("origin_quota", 2): raise HAError("live pools exceed the two-origin quota; refusing mutation")
    failures = []
    for change in changes:
        name, desired = change["resource"], change["desired"]
        try:
            if name == "monitor": client.patch(paths(cfg)["monitor"], desired)
            elif name == "load_balancer": client.patch(paths(cfg)["lb"], desired)
            elif name.startswith("pool:"):
                node = next(n for n in cfg["nodes"] if n["name"] == name.split(":", 1)[1])
                client.patch(f"/accounts/{cfg['account_id']}/load_balancers/pools/{node['pool']['id']}", desired)
            else:
                node = next(n for n in cfg["nodes"] if n["name"] == name.split(":", 1)[1])
                client.put(f"/accounts/{cfg['account_id']}/cfd_tunnel/{node['tunnel_id']}/configurations", {"config": desired})
            remaining = [c for c in build_plan(cfg, fetch_state(client, cfg)) if c["resource"] == name]
            if remaining: raise HAError("post-update verification still reports drift")
            print(f"updated and verified: {name}")
        except Exception as exc: failures.append(f"{name}: {exc}"); print(f"FAILED: {name}: {exc}", file=sys.stderr)
    if failures: raise HAError("partial apply; inspect before retry: " + "; ".join(failures))


def set_origin_enabled(client: Any, cfg: dict[str, Any], node_name: str,
                       enabled: bool, approved: bool) -> None:
    """Drain/restore one adopted origin without reconciling any other field."""
    if not approved:
        raise HAError("origin state change requires --approve; no changes were made")
    try:
        node = next(item for item in cfg["nodes"] if item["name"] == node_name)
    except StopIteration:
        raise HAError(f"unknown HA node: {node_name}") from None
    path = f"/accounts/{cfg['account_id']}/load_balancers/pools/{node['pool']['id']}"
    live = client.get(path)
    origins = live.get("origins")
    expected = node["pool"]["origin"]
    matches = [origin for origin in origins or []
               if origin.get("name") == expected["name"] and origin.get("address") == expected["address"]]
    if len(origins or []) != 1 or len(matches) != 1:
        raise HAError("pool origin inventory differs from the adopted one-origin topology")
    if bool(matches[0].get("enabled")) == enabled:
        print(f"{node_name}: origin already {'enabled' if enabled else 'drained'}")
        return
    # Re-read immediately before the write. The entire live pool document is
    # retained so Cloudflare fields unknown to this client are not erased.
    fresh = client.get(path)
    if fresh != live:
        raise HAError("pool changed during approval window; retry after inspection")
    desired = copy.deepcopy(fresh)
    desired["origins"][0]["enabled"] = enabled
    client.patch(path, desired)
    verified = client.get(path)
    verified_origins = verified.get("origins", [])
    if len(verified_origins) != 1 or bool(verified_origins[0].get("enabled")) != enabled:
        raise HAError("origin update could not be verified")
    print(f"{node_name}: origin {'restored' if enabled else 'drained'} and verified")


def run(args: list[str], timeout: int = 12) -> tuple[bool, str]:
    try:
        p = subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)
        return p.returncode == 0, (p.stdout + p.stderr).strip()
    except (subprocess.TimeoutExpired, OSError) as exc: return False, str(exc)


def probe_node(alias: str) -> tuple[bool, str]:
    return run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", alias,
                "curl --silent --show-error --fail --max-time 5 http://127.0.0.1:8080/health/ready"])


def probe_public(hostname: str, path: str) -> tuple[bool, str]:
    return run(["curl", "--silent", "--show-error", "--fail", "--max-time", "10", f"https://{hostname}{path}"])


def health_summary(value: dict[str, Any]) -> str:
    pops = value.get("pop_health", {})
    healthy = sum(1 for item in pops.values() if item.get("healthy"))
    return f"{healthy}/{len(pops)} Cloudflare locations healthy"


def status(client: Any, cfg: dict[str, Any]) -> bool:
    state = fetch_state(client, cfg, health=True)
    changes = build_plan(cfg, state)
    lb = state["lb"]
    print(f"LB {lb.get('name')}: enabled={lb.get('enabled')} pools={lb.get('default_pools')}")
    ok = bool(lb.get("enabled")) and not changes
    for node, live in zip(cfg["nodes"], state["nodes"]):
        ssh_ok, body = probe_node(node["ssh_alias"])
        print(f"{node['name']}: pool={health_summary(live['health'])}; tunnel={live['tunnel'].get('status')}; local_ready={ssh_ok} {body[:200]}")
        ok = ok and ssh_ok and live["tunnel"].get("status") == "healthy"
    public_ok, body = probe_public(cfg["hostname"], "/health/ready")
    print(f"public sample (one edge request only): ready={public_ok} {body[:200]}")
    print_plan(changes)
    return ok and public_ok


def test_readiness(cfg: dict[str, Any]) -> bool:
    ok = True
    for node in cfg["nodes"]:
        passed, body = probe_node(node["ssh_alias"])
        identity_ok = passed and node["pool"]["origin"]["name"] in body
        print(f"{node['name']} local readiness: {'PASS' if passed else 'FAIL'}; identity: {'PASS' if identity_ok else 'not verified'}; {body[:200]}")
        ok = ok and passed
    for path in ("/", "/health/ready"):
        passed, body = probe_public(cfg["hostname"], path)
        print(f"public {path}: {'PASS' if passed else 'FAIL'}; {body[:200]}")
        ok = ok and passed
    print("Public probes sample one route and do not prove global edge behavior.")
    return ok


def failover_test(client: Any, cfg: dict[str, Any], args: argparse.Namespace) -> bool:
    if not args.stop_command or not args.start_command or not args.confirm_failover:
        raise HAError("--failover requires --confirm-failover plus explicit --stop-command and --start-command adapters")
    state = fetch_state(client, cfg, health=True)
    secondary = state["nodes"][1]
    ready, _ = probe_node(cfg["nodes"][1]["ssh_alias"])
    if not ready or not all(v.get("healthy") for v in secondary["health"].get("pop_health", {}).values()):
        raise HAError("secondary is not fully ready and healthy; refusing failover test")
    primary = cfg["nodes"][0]["ssh_alias"]
    restored = False
    def restore(*_: Any) -> None:
        nonlocal restored
        if not restored:
            restored = True
            subprocess.run(["ssh", "-o", "BatchMode=yes", primary, args.start_command], check=False, timeout=30)
    old_int, old_term = signal.signal(signal.SIGINT, restore), signal.signal(signal.SIGTERM, restore)
    started = time.monotonic()
    try:
        subprocess.run(["ssh", "-o", "BatchMode=yes", primary, args.stop_command], check=True, timeout=30)
        deadline = time.monotonic() + args.wait_seconds
        while time.monotonic() < deadline:
            passed, body = probe_public(cfg["hostname"], "/health/ready")
            if passed and cfg["nodes"][1]["pool"]["origin"]["name"] in body:
                print(f"failover observed after {time.monotonic() - started:.1f}s"); break
            time.sleep(5)
        else: raise HAError("bounded wait expired before secondary routing was observed")
    finally:
        restore(); signal.signal(signal.SIGINT, old_int); signal.signal(signal.SIGTERM, old_term)
    deadline = time.monotonic() + args.wait_seconds
    while time.monotonic() < deadline:
        passed, body = probe_public(cfg["hostname"], "/health/ready")
        if passed and cfg["nodes"][0]["pool"]["origin"]["name"] in body:
            print(f"failback observed after {time.monotonic() - started:.1f}s total"); return True
        time.sleep(5)
    raise HAError("primary was restarted, but bounded failback observation expired")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan"); sub.add_parser("status")
    ap = sub.add_parser("apply"); ap.add_argument("--approve", action="store_true")
    for command in ("drain", "restore"):
        origin = sub.add_parser(command)
        origin.add_argument("--node", required=True)
        origin.add_argument("--approve", action="store_true")
    tp = sub.add_parser("test"); tp.add_argument("--failover", action="store_true")
    tp.add_argument("--confirm-failover", action="store_true"); tp.add_argument("--stop-command")
    tp.add_argument("--start-command"); tp.add_argument("--wait-seconds", type=int, default=240)
    args = parser.parse_args(argv)
    try:
        cfg = load_config(args.config)
        if args.command == "test" and not args.failover: return 0 if test_readiness(cfg) else 1
        client = Cloudflare(token())
        if args.command == "plan": print_plan(build_plan(cfg, fetch_state(client, cfg))); return 0
        if args.command == "status": return 0 if status(client, cfg) else 1
        if args.command == "apply": apply(client, cfg, args.approve); return 0
        if args.command in ("drain", "restore"):
            set_origin_enabled(client, cfg, args.node, args.command == "restore", args.approve)
            return 0
        return 0 if failover_test(client, cfg, args) else 1
    except (HAError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr); return 2


if __name__ == "__main__": raise SystemExit(main())
