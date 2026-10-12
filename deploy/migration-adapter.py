#!/usr/bin/env python3
"""Gate 2 adapter: immutable R2 upload and one atomic PostgreSQL publication."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "deploy/production-migration.json"
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
NAMESPACE = uuid.UUID("c2dcc86d-e0e7-4f79-99bd-4e501167a511")


class MigrationError(RuntimeError): pass


def run(argv: list[str], *, env: dict[str, str] | None = None, stdin: str | None = None,
        timeout: int = 600, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, input=stdin, text=True, capture_output=True, env=env, timeout=timeout, check=False)
    if check and result.returncode:
        message = result.stderr.strip() or result.stdout.strip()
        raise MigrationError(f"{argv[0]} failed: {message[-1500:]}")
    return result


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""): value.update(block)
    return value.hexdigest()


def secret(path: str) -> str:
    target = Path(path).expanduser()
    if not target.is_file() or target.stat().st_mode & 0o077: raise MigrationError(f"credential file missing or insecure: {target.name}")
    value = target.read_text().strip()
    if not value: raise MigrationError(f"credential file is empty: {target.name}")
    return value


def aws_env(cfg: dict[str, Any]) -> tuple[dict[str, str], str]:
    names = cfg["controller_secrets"]
    env = {**os.environ, "AWS_ACCESS_KEY_ID": secret(names["r2_access_key"]),
           "AWS_SECRET_ACCESS_KEY": secret(names["r2_secret_key"]), "AWS_DEFAULT_REGION": "auto",
           "AWS_EC2_METADATA_DISABLED": "true", "AWS_PAGER": ""}
    return env, secret(names["r2_bucket"])


def object_descriptor(path: Path, media_type: str, tenant: str) -> dict[str, Any]:
    digest = sha256(path)
    return {"key": f"tenants/{tenant}/sha256/{digest}", "sha256": digest,
            "size": path.stat().st_size, "mediaType": media_type}


def upload_immutable(cfg: dict[str, Any], path: Path, descriptor: dict[str, Any], env: dict[str, str], bucket: str) -> str:
    base = ["aws", "--endpoint-url", cfg["r2_endpoint"], "s3api"]
    head = run(base + ["head-object", "--bucket", bucket, "--key", descriptor["key"]], env=env, check=False)
    if head.returncode == 0:
        value = json.loads(head.stdout)
        metadata = value.get("Metadata", {})
        if int(value.get("ContentLength", -1)) != descriptor["size"] or metadata.get("sha256") != descriptor["sha256"]:
            raise MigrationError(f"immutable object collision: {descriptor['key']}")
        status = "reused"
    else:
        if "404" not in head.stderr and "Not Found" not in head.stderr and "NoSuchKey" not in head.stderr:
            raise MigrationError(f"R2 head failed without a not-found response: {head.stderr[-500:]}")
        put = base + ["put-object", "--bucket", bucket, "--key", descriptor["key"], "--body", str(path),
                      "--content-type", descriptor["mediaType"], "--metadata", f"sha256={descriptor['sha256']}", "--if-none-match", "*"]
        run(put, env=env, timeout=1800)
        verify = json.loads(run(base + ["head-object", "--bucket", bucket, "--key", descriptor["key"]], env=env).stdout)
        if int(verify.get("ContentLength", -1)) != descriptor["size"] or verify.get("Metadata", {}).get("sha256") != descriptor["sha256"]:
            raise MigrationError(f"R2 verification failed: {descriptor['key']}")
        status = "uploaded"
    # Metadata alone is not proof of stored-byte integrity. Read each object
    # back and compare it with the source before making it authoritative.
    with tempfile.TemporaryDirectory(prefix="cursus-r2-verify-") as temporary:
        downloaded = Path(temporary) / "object"
        run(base + ["get-object", "--bucket", bucket, "--key", descriptor["key"], str(downloaded)], env=env, timeout=1800)
        if downloaded.stat().st_size != descriptor["size"] or sha256(downloaded) != descriptor["sha256"]:
            raise MigrationError(f"R2 downloaded content checksum mismatch: {descriptor['key']}")
    return status


def sql_json(value: Any) -> str:
    encoded = base64.b64encode(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).decode()
    return f"convert_from(decode('{encoded}','base64'),'UTF8')::jsonb"


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def load_sources(cfg: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    root = Path(cfg["legacy_state"])
    groups = []
    for name in ("scenarios", "plans", "jobs"):
        groups.append([json.loads(path.read_text()) for path in sorted((root / name).glob("*.json"))])
    expected = cfg["expected"]
    if tuple(map(len, groups)) != (expected["scenarios"], expected["plans"], expected["jobs"]):
        raise MigrationError("legacy entity counts changed")
    return groups[0], groups[1], groups[2]


def admins(cfg: dict[str, Any]) -> list[str]:
    values = sorted({line.strip().lower() for line in Path(cfg["controller_secrets"]["allowlist"]).expanduser().read_text().splitlines() if line.strip()})
    if len(values) != cfg["expected"]["admins"] or any(not EMAIL.match(item) for item in values):
        raise MigrationError("external allowlist does not contain the expected unique valid administrators")
    return values


def postgres(cfg: dict[str, Any], sql: str) -> str:
    target = cfg["primary"]
    command = ["ssh", "-o", "BatchMode=yes", target["ssh_alias"], "docker", "exec", "-i",
               target["postgres_container"], "psql", "-v", "ON_ERROR_STOP=1", "-U", "cursus", "-d", "cursus", "-At"]
    return run(command, stdin=sql, timeout=600).stdout.strip()


def build_sql(cfg: dict[str, Any], scenarios: list[dict[str, Any]], plans: list[dict[str, Any]], jobs: list[dict[str, Any]],
              objects: list[tuple[dict[str, Any], dict[str, Any]]], manifest: dict[str, Any], allowlist: list[str]) -> tuple[str, dict[str, str]]:
    tenant = cfg["tenant_id"]; lines = ["BEGIN;", "SELECT pg_advisory_xact_lock(1129665107);",
      f"DO $$ BEGIN IF (SELECT count(*) FROM tenants WHERE id={sql_text(tenant)}) <> 1 THEN RAISE EXCEPTION 'production tenant missing'; END IF;",
      f"IF (SELECT count(*) FROM scenarios WHERE tenant_id={sql_text(tenant)}) <> 0 OR (SELECT count(*) FROM plans WHERE tenant_id={sql_text(tenant)}) <> 0 OR (SELECT count(*) FROM datasets WHERE tenant_id={sql_text(tenant)}) <> 0 OR (SELECT count(*) FROM jobs WHERE tenant_id={sql_text(tenant)}) <> 0 OR (SELECT count(*) FROM objects WHERE tenant_id={sql_text(tenant)}) <> 0 OR (SELECT count(*) FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id={sql_text(tenant)}) <> 0 THEN RAISE EXCEPTION 'production tenant is not empty'; END IF; END $$;"]
    for email in allowlist:
        user_id = str(uuid.uuid5(NAMESPACE, f"user:{email}"))
        lines += [f"INSERT INTO users(id,email) VALUES('{user_id}'::uuid,{sql_text(email)});",
                  f"INSERT INTO memberships(tenant_id,user_id,role) VALUES({sql_text(tenant)},'{user_id}'::uuid,'admin');"]
    for item in scenarios:
        lines.append(f"INSERT INTO scenarios(tenant_id,id,revision,body,created_at,updated_at) VALUES({sql_text(tenant)},{sql_text(item['id'])},{int(item['revision'])},{sql_json(item)},{sql_text(item['createdAt'])}::timestamptz,{sql_text(item['createdAt'])}::timestamptz);")
    for item in plans:
        lines.append(f"INSERT INTO plans(tenant_id,id,scenario_id,scenario_revision,body,created_at) VALUES({sql_text(tenant)},{sql_text(item['id'])},{sql_text(item['scenarioId'])},{int(item['scenarioRevision'])},{sql_json(item)},{sql_text(item['createdAt'])}::timestamptz);")
    for _, obj in objects:
        lines.append(f"INSERT INTO objects(tenant_id,object_key,sha256,size_bytes,media_type,state,published_at) VALUES({sql_text(tenant)},{sql_text(obj['key'])},{sql_text(obj['sha256'])},{obj['size']},{sql_text(obj['mediaType'])},'published',now());")
    lines.append(f"INSERT INTO datasets(tenant_id,id,manifest,status,schema_version,validated_at,admitted_at) VALUES({sql_text(tenant)},{sql_text(cfg['dataset_id'])},{sql_json(manifest)},'admitted',1,now(),now());")
    mappings = {}
    for item in jobs:
        mapped = str(uuid.uuid5(NAMESPACE, f"job:{tenant}:{item['id']}")); mappings[item["id"]] = mapped
        payload = {"legacyId": item["id"], "scenarioId": item["scenarioId"], "scenarioRevision": item["scenarioRevision"], "datasetId": cfg["dataset_id"], "migrated": True}
        result = {"legacyId": item["id"], "planId": item["planId"], "termination": item.get("termination"), "elapsedSec": item.get("elapsedSec")}
        lines.append(f"INSERT INTO jobs(tenant_id,id,kind,idempotency_key,payload,state,attempt,fence,result,created_at,updated_at) VALUES({sql_text(tenant)},'{mapped}'::uuid,'solve',{sql_text('legacy:'+item['id'])},{sql_json(payload)},'succeeded',1,1,{sql_json(result)},{sql_text(item['createdAt'])}::timestamptz,{sql_text(item.get('finishedAt') or item['createdAt'])}::timestamptz);")
    lines += ["COMMIT;", f"SELECT json_build_object('users',(SELECT count(*) FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id={sql_text(tenant)}),'memberships',(SELECT count(*) FROM memberships WHERE tenant_id={sql_text(tenant)}),'scenarios',(SELECT count(*) FROM scenarios WHERE tenant_id={sql_text(tenant)}),'plans',(SELECT count(*) FROM plans WHERE tenant_id={sql_text(tenant)}),'objects',(SELECT count(*) FROM objects WHERE tenant_id={sql_text(tenant)}),'datasets',(SELECT count(*) FROM datasets WHERE tenant_id={sql_text(tenant)}),'jobs',(SELECT count(*) FROM jobs WHERE tenant_id={sql_text(tenant)}),'outbox',(SELECT count(*) FROM email_outbox WHERE tenant_id={sql_text(tenant)}));"]
    return "\n".join(lines) + "\n", mappings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--stage", required=True); parser.add_argument("--nonce", required=True)
    parser.add_argument("--config", type=Path, default=CONFIG); parser.add_argument("--source-manifest", type=Path, default=Path(os.environ.get("CURSUS_SOURCE_MANIFEST", "")))
    args = parser.parse_args(); started = time.monotonic()
    try:
        if args.stage != "migration": raise MigrationError("adapter only supports the migration stage")
        cfg = json.loads(args.config.read_text())
        if not args.source_manifest.is_file(): raise MigrationError("CURSUS_SOURCE_MANIFEST must identify the verified private manifest")
        source_manifest = json.loads(args.source_manifest.read_text())
        verify = run([sys.executable, str(ROOT / "deploy/migration-source.py"), "--config", str(args.config), "verify", "--manifest", str(args.source_manifest)])
        verified = json.loads(verify.stdout)
        scenarios, plans, jobs = load_sources(cfg); allowlist = admins(cfg); env, bucket = aws_env(cfg)
        dataset = Path(cfg["dataset_root"]); objects = []
        for item in cfg["authoritative_dataset_files"]:
            path = dataset / item["path"]; descriptor = object_descriptor(path, item["media_type"], cfg["tenant_id"])
            status = upload_immutable(cfg, path, descriptor, env, bucket); objects.append((dict(item, upload=status), descriptor))
        by_role = {item["role"]: obj for item, obj in objects}
        manifest = {"schemaVersion": 1, "label": "Gyermelyi", "migration": {"sourceManifestSha256": verified["manifest_sha256"],
                    "legacyDatasetId": cfg["dataset_id"], "identity": "checksum-addressed-authoritative-legacy-import"},
                    "source": by_role["raw-orders"], "rawInputs": [{"role": item["role"], **obj} for item, obj in objects if item["role"].startswith("raw-")],
                    "artifacts": {"request": by_role["solver-request"], "geocoded": by_role["geocoded-orders"]}, "days": cfg["days"]}
        sql, mappings = build_sql(cfg, scenarios, plans, jobs, objects, manifest, allowlist)
        inventory = json.loads(postgres(cfg, sql).splitlines()[-1])
        expected = {"users": cfg["expected"]["admins"], "memberships": cfg["expected"]["admins"],
                    "scenarios": 2, "plans": 1, "objects": 5, "datasets": 1, "jobs": 1, "outbox": 0}
        if inventory != expected: raise MigrationError(f"post-migration inventory mismatch: {inventory}")
        result = {"success": True, "nonce": args.nonce, "source_manifest_sha256": source_manifest["manifest_sha256"],
                  "inventory": inventory, "dataset_id": cfg["dataset_id"], "object_uploads": {item["role"]: item["upload"] for item, _ in objects},
                  "legacy_id_mappings": {"jobs": mappings}, "duration_seconds": round(time.monotonic() - started, 3),
                  "production_email_sent": False, "staging_imported": False}
        print(json.dumps(result, sort_keys=True)); return 0
    except (OSError, KeyError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired, MigrationError) as exc:
        print(f"error: {exc}", file=sys.stderr); return 2


if __name__ == "__main__": raise SystemExit(main())
