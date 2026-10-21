# Read-only operational checks

Run on the independent controller using existing SSH aliases:

```sh
python3 deploy/monitor.py
```

Uses `deploy/production.json`, bounded concurrent SSH/SQL/HTTP probes and JSON
output. Exit 0 means sampled checks passed; exit 1 means an alert or failed probe.
No rebuild, restart, SQL write, backup creation, WAL switch, promotion or email.
No credentials, customer records or raw subprocess errors are printed.

Checks: readiness, expected database roles, one asynchronous streaming standby,
byte lag (64 MiB default), standby replay pause, lost/unreserved WAL slots,
unrecovered archive failures on either node, free disk (10% or 20 GiB minimum),
and primary base-backup completion age (24 hours). Tune with `--backup-max-hours`
and `--lag-max-bytes`. Invalid data/unreachable nodes fail closed. Idle WAL
timestamps alone are not failures. Async lag samples are not an RPO guarantee.

Backup age reads `/backup/latest` and its completion marker, not checksums,
off-node durability or restore/PITR evidence. Recent logical release dumps do
not refresh that physical backup marker. Failed SSH is never fencing proof.

## Notifications

No scheduler or receiver is installed automatically. Choose an always-on
independent controller and an existing HTTPS receiver accepting this JSON
envelope (not automatically compatible with Slack/Teams payload formats).
It should deduplicate by node/code, notify on recovery, and alarm on missing
heartbeats. Local cron cannot alert if its controller is asleep/offline.

Store the secret endpoint in `~/.config/cursus/alert-webhook`, mode 0600, outside
Git, or set `CURSUS_ALERT_WEBHOOK_FILE` to a protected external file. Never paste
secret URLs into repository configuration or logs.

```sh
python3 deploy/monitor.py --notify
```

Only explicit `--notify` posts a sanitized snapshot, including healthy snapshots,
with 10-second timeout, no redirects or automatic POST retries. Delivery failure
exits 1. After approval and a receiver test, schedule every five minutes with
absolute Python/repository paths using the controller's existing scheduler.
Capture failures rather than discarding output. No production cron changes or
host package installation are needed for manual checks.

Every alert includes a next action. Remediation remains separate: never delete
PostgreSQL/WAL files manually, restore over live data, restart both origins or
promote without independently verified fencing.
