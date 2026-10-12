#!/usr/bin/env python3
"""Create and verify a private, content-addressed Gate 2 source manifest."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "deploy/production-migration.json"


class SourceError(RuntimeError): pass


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""): value.update(block)
    return value.hexdigest()


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if value.get("schema_version") != 1: raise SourceError("unsupported migration configuration")
    return value


def classify(relative: str, cfg: dict[str, Any]) -> str:
    selected = {item["path"]: item["role"] for item in cfg["authoritative_dataset_files"]}
    if relative in selected: return selected[relative]
    if any(relative.startswith(prefix) for prefix in cfg["excluded_prefixes"]): return "regenerable-or-nonauthoritative"
    return "supporting-source"


def entries(root: Path, kind: str, cfg: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        result.append({"root": kind, "path": relative, "size": path.stat().st_size,
                       "sha256": sha256(path), "classification": "legacy-state" if kind == "legacy" else classify(relative, cfg)})
    return result


def validate_inventory(cfg: dict[str, Any], all_entries: list[dict[str, Any]]) -> dict[str, Any]:
    legacy = Path(cfg["legacy_state"]); dataset = Path(cfg["dataset_root"])
    scenarios = sorted((legacy / "scenarios").glob("*.json")); plans = sorted((legacy / "plans").glob("*.json")); jobs = sorted((legacy / "jobs").glob("*.json"))
    expected = cfg["expected"]
    counts = {"scenarios": len(scenarios), "plans": len(plans), "jobs": len(jobs),
              "dataset_files": sum(1 for item in all_entries if item["root"] == "dataset")}
    if any(counts[key] != expected[key] for key in counts): raise SourceError(f"source inventory mismatch: {counts}")
    scenario_values = [json.loads(path.read_text()) for path in scenarios]
    plan_values = [json.loads(path.read_text()) for path in plans]
    job_values = [json.loads(path.read_text()) for path in jobs]
    scenario_revisions = {(item["id"], item["revision"]) for item in scenario_values}
    plan_ids = {item["id"] for item in plan_values}
    if any((item["scenarioId"], item["scenarioRevision"]) not in scenario_revisions for item in plan_values):
        raise SourceError("a plan references a missing scenario revision")
    if any((item["scenarioId"], item["scenarioRevision"]) not in scenario_revisions or item.get("planId") not in plan_ids for item in job_values):
        raise SourceError("a job references a missing scenario revision or plan")
    selected = {item["path"] for item in cfg["authoritative_dataset_files"]}
    present = {item["path"] for item in all_entries if item["root"] == "dataset"}
    if not selected <= present: raise SourceError(f"selected authoritative files missing: {sorted(selected - present)}")
    role_paths = {item["role"]: item["path"] for item in cfg["authoritative_dataset_files"]}
    request = json.loads((dataset / role_paths["solver-request"]).read_text())
    geocoded = json.loads((dataset / role_paths["geocoded-orders"]).read_text())
    rows = geocoded.get("records", geocoded) if isinstance(geocoded, dict) else geocoded
    dates = sorted({str(row.get("delivery_date")) for row in rows})
    configured_dates = sorted(day["date"] for day in cfg["days"])
    if dates != configured_dates: raise SourceError(f"dataset day mismatch: {dates}")
    return {**counts, "scenario_ids": sorted(item["id"] for item in scenario_values),
            "plan_ids": sorted(plan_ids), "legacy_job_ids": sorted(item["id"] for item in job_values),
            "solver": {name: len(request.get(name, [])) for name in ("locations", "vehicles", "tasks", "requests")},
            "dataset_dates": dates}


def manifest(cfg: dict[str, Any]) -> dict[str, Any]:
    roots = {"legacy": Path(cfg["legacy_state"]), "dataset": Path(cfg["dataset_root"])}
    for name, path in roots.items():
        if not path.is_dir(): raise SourceError(f"{name} source directory is missing: {path}")
    files = entries(roots["legacy"], "legacy", cfg) + entries(roots["dataset"], "dataset", cfg)
    inventory = validate_inventory(cfg, files)
    body = {"schema_version": 1, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "roots": {key: str(value.resolve()) for key, value in roots.items()}, "inventory": inventory, "files": files}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    body["manifest_sha256"] = hashlib.sha256(canonical).hexdigest()
    return body


def verify(value: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    stored = value.get("manifest_sha256"); unsigned = dict(value); unsigned.pop("manifest_sha256", None)
    actual = hashlib.sha256(json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if stored != actual: raise SourceError("manifest checksum is invalid")
    before = {(item["root"], item["path"]): (item["size"], item["sha256"]) for item in value["files"]}
    current_files = entries(Path(cfg["legacy_state"]), "legacy", cfg) + entries(Path(cfg["dataset_root"]), "dataset", cfg)
    after = {(item["root"], item["path"]): (item["size"], item["sha256"]) for item in current_files}
    if before != after: raise SourceError("source changed after manifest creation")
    return {"valid": True, "manifest_sha256": stored, "inventory": value["inventory"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create"); create.add_argument("--output", required=True, type=Path)
    check = sub.add_parser("verify"); check.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    try:
        cfg = load(args.config)
        if args.command == "create":
            value = manifest(cfg); args.output.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as handle: json.dump(value, handle, indent=2, sort_keys=True); handle.write("\n")
            result = {"created": str(args.output), "manifest_sha256": value["manifest_sha256"], "inventory": value["inventory"]}
        else: result = verify(json.loads(args.manifest.read_text()), cfg)
        print(json.dumps(result, indent=2, sort_keys=True)); return 0
    except (OSError, KeyError, ValueError, SourceError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr); return 2


if __name__ == "__main__": raise SystemExit(main())
