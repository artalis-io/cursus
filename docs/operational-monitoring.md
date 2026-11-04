# Operational alerts and scheduled restore verification

These controller-side Python tools reuse `deploy/production.json`. They make no application builds, deployments, restarts, database promotions, Cloudflare changes or automatic repairs. The node probe uses existing SSH aliases and reads HTTP readiness, container state, PostgreSQL role/identity/replication/archive views (including the recovery manager’s pinned cluster identity), disk space, recovery uncertainty and allowlisted R2 diagnostic counters. Public readiness is one controller observation, not proof of global Cloudflare edge behavior.

## Controller setup and commands

Prerequisites: existing Python 3.11+, working batch-mode SSH aliases, PostgreSQL images already local on the Sparks, and an existing macOS user launchd session on control-mac. No packages, users, Docker configuration or host services are installed. State and backups must be outside every Git checkout, with private directories/files. In this deployment they reside under `/Users/mark/artalis.io/data/cursus-operations`.

```sh
python3 deploy/ops.py --state-dir /absolute/private/cursus-operations monitor
python3 deploy/ops.py --state-dir /absolute/private/cursus-operations verify-backup
python3 deploy/ops.py --state-dir /absolute/private/cursus-operations status
python3 deploy/ops.py --state-dir /absolute/private/cursus-operations \
  --notifications /absolute/private/notifications.json schedule install --approve
python3 deploy/ops.py --state-dir /absolute/private/cursus-operations schedule status
python3 deploy/ops.py --state-dir /absolute/private/cursus-operations schedule uninstall --approve
```

Installation pins a source/configuration/inventory snapshot outside the checkout, so switching Git branches cannot change a scheduled run. Each run verifies those source checksums. Installation is idempotent, preserves unrelated LaunchAgents, rejects unknown label/file conflicts and records partial failures. Uninstall removes only matching owned schedules; reports, state, runtime snapshots and backups remain. Reinstall explicitly to adopt changed source or inventory.

The monitor runs every minute. The independent restore job is scheduled hourly while the controller is available and performs a new backup/verification when 24 hours have passed since success; failed attempts are retried no sooner than one hour. Neither job overlaps another instance of itself. Jobs run at load too. The restore task cannot block the monitoring task. Both are application-owned **user LaunchAgents**, not Spark cron jobs. They require control-mac awake and its user session available; they do not provide monitoring-host HA or alerts while that controller is offline. Reports and staleness checks catch overdue verification after it returns. An always-on external monitor is a separate deployment choice.

## Notifications and incidents

Notifications are configured outside Git in a mode-0600 regular file. Default local delivery requires no email addresses or provider credentials:

```json
{"backend":"local"}
```

Optional email delivery uses the existing Resend service. Operator recipients are separate from application login allowlists and must never be checked in:

```json
{"backend":"resend","from":"Cursus Operations <login@cursus.artalis.io>","to":["operator@example.test"],"api_key_file":"/absolute/private/resend-key"}
```

The key remains on the controller. No credentials go to Sparks. Configure real recipients before choosing email delivery. Delivery sends only check identity, incident/recovery status and a static action, without customer data, object keys, raw logs or provider errors. Local notifications are best effort and subject to macOS notification/Focus settings; provider acceptance does not prove a human read an alert.

Default thresholds live in `deploy/operations.json`: three separated failed samples open an incident; two healthy samples resolve it. Manual rapid invocations do not advance the sustained-failure counter. Restore failures alert on their first sampled failure. Missing/unknown observations fail closed; a disappearing check cannot silently clear an incident. An unavailable node probe raises one transport incident and suppresses derivative checks without marking them recovered. Database-dependent identity/replication/archive checks remain unknown until their parent observations return. The LaunchAgent PATH includes the standard Homebrew locations used by existing SSH proxy commands; validate a real scheduled probe after installation, not merely that the agent loaded. A verified recovery pause suppresses only app/R2 health noise for 15 minutes; database, public readiness and recovery uncertainty remain monitored.

One incident event and one recovery event are persisted. Pending delivery is recorded **before** sending. Email retries retain the exact body/destination and Resend idempotency key. Retries stop after 23 hours from first attempt to remain within Resend's documented 24-hour retention; an older ambiguous delivery needs operator review. This is not an exactly-once delivery guarantee. Local notifications have no provider idempotency guarantee if the process crashes after OS acceptance. Incidents resolved before notification delivery was ever configured are retained locally and not mailed retrospectively. Never delete deduplication state to force retries.

Check `monitor-report.json`, `monitor-state.json` and the job logs in the private state directory. `pending_notifications`/`ambiguous_notifications` make delivery problems visible. The facility does not add a monitoring database, external CI platform or automatic remediation. Existing Cloudflare `deploy/ha.py status` remains the full topology/edge inspection tool.

## What restore verification proves

The job opens a read-only repeatable-read PostgreSQL transaction, exports its snapshot, and records counts/checksums for all public tables. `pg_dump --snapshot` imports **that same snapshot**, so concurrent production writes cannot mix revisions in the evidence. The snapshot is closed promptly after the dump is durable on the controller. Inventory checksums include UTC-normalized values and deterministic C-collation ordering. Backup archives have SHA-256 checksums and private permissions.

The identical, already-local PostgreSQL image starts on the secondary as a unique nonce-labelled temporary container. It has no network, no production mounts, no writable root filesystem, no added capabilities, and only disposable tmpfs storage. One CPU, 2 GiB memory and a 1 GiB temporary data directory bound drill resource use; these are verifier limits, not changes to production service resources. Restore imports the off-node archive, verifies schema and every table's count/checksum, then removes only the container carrying that run's ownership label. The source, standby and app containers are never stopped or reseeded.

Only a fully successful restore and cleanup updates `verified-restore.json`. Failed/incomplete attempts cannot replace the last good evidence. A lost SSH connection or mismatched ownership leaves an explicit cleanup failure and blocks new drills until reviewed. Each command and the overall drill are bounded; cleanup gets a separate bounded opportunity. The report includes stage, duration, source database system identity/timeline, exact image, archive checksum, snapshot consistency and cleanup state. Private diagnostics stay beside the archive, never in notification bodies or Git.

These are logical **application database** backups. They complement physical base backups, WAL archives, role/secret backups and R2 immutable-object retention; they do not establish PITR, continuous off-node WAL archival, a fixed RPO, global-role recovery or automatic database HA. Backup material contains sensitive authentication/application data. Keep controller storage protected and independently backed up. Retention/deletion is deliberately manual; the jobs never prune customer data, archives or previous evidence. Monitor disk space.

## Failure actions

- Readiness/R2: inspect generic readiness code and structured `object-storage` events. Preserve the healthy serving origin. Do not silently bypass R2 readiness.
- Replication/identity: inspect roles, receiver, lag and WAL slots. Never promote or reseed automatically; SSH failure is not fencing evidence.
- WAL archive: completed `.ready` files older than the threshold indicate backlog. An idle database with no completed WAL pending does not create an age-only alarm. Cumulative old failure counters alone are not an incident.
- Restore: inspect `restore-attempt.json` and its private diagnostics. Never restore over the live database. On uncertain cleanup, inspect the exact nonce-labelled container and confirm no run is still active before resolving the private attempt's cleanup flag. Never remove containers by a broad prefix.
- Disk/delivery: investigate retention or notification configuration manually. Removing backups or clearing notification state is not automatic recovery.

## Tests and evidence

Credential-free unit tests cover hysteresis, deduplication, recovery, unknown observations, maintenance, private files, scheduler conflicts/idempotency and crash-after-provider-acceptance retries. CI's disposable PostgreSQL integration inserts a row **after** snapshot export and proves the restored backup contains the earlier version, with every table checksum verified. The source fixture is guarded by its exact CI container/project identity.

A real off-node production dump and isolated ARM64 restore on the secondary was also executed during implementation: schema 5, 18 tables, all counts/checksums matched, cleanup completed, no authoritative production writes. Initial verifier startup failures were isolated and cleaned up before success; they were caused by temporary-container socket initialization and are retained as private diagnostics. No private datasets or fixtures were added to the repository.
