# Existing deployment recovery after reboot

The app's availability depends on PostgreSQL connectivity, not merely healthy
containers. On 18 October 2026 a changed Wi-Fi subnet left both apps pointing at
an absent address. Docker also reported the primary database healthy with its
configured host port absent. The standby had missed an archived WAL segment.

Use Compose DNS `postgres:5432` for the colocated primary app. Use the dedicated
node-to-node private link for remote database access and replication (currently
10.77.0.1 / 10.77.0.2), not DHCP Wi-Fi addresses. Only bind the database's host
port on that private interface; never use a wildcard/public binding. Preserve
the secret URL's credentials when changing endpoints. Primary and standby must
keep their existing system identifier and roles.

The internal `deploy/boot-recover.py` helper reconciles an **existing** deployment
only through its integrity-checking manager, which supplies the pinned project
and database identity. Do not invoke the helper without those identity arguments.
It locks against overlap, waits by failing/retrying when the interface is absent,
requires initialized PGDATA and the expected role, rejects image drift, and
never builds, pulls, promotes, restores a database or initializes a new cluster.
If Docker lost the database port binding, it recreates that container against
the same verified persistent directory. It compares the current container mount,
configured path, rendered Compose mount and pinned PostgreSQL system identifier;
another initialized directory or cluster is not an acceptable substitute. It
also requires current/rendered Compose configuration hashes to match for all
four services. Recovery must not apply a pending deployment/configuration change.
The environment and Compose model are captured into a private, mode-0700
temporary directory; files are mode 0600, never logged or committed. The rendered
model preserves Compose's existing literal-dollar escaping and must round-trip
unchanged. All validation, hashes and writes use this same frozen configuration,
not later edits to live files. Automatic database recreation also requires an
immutable image reference. Normal starts retain `--no-recreate`.
Otherwise healthy matching services are not
recreated. Docker/Compose prerequisites remain Herding Sparks' responsibility.

## Deployment-managed schedule

New approved provisioning (`deploy/cutover.py provision`) installs recovery jobs
after candidate/database readiness and backup/restore verification. It records
installation evidence in the provision report. For existing deployments use the
same production inventory and explicit management commands from the controller:

```sh
python3 deploy/cutover.py recovery install --approve
python3 deploy/cutover.py recovery status
python3 deploy/cutover.py recovery pause --node spark-3eb0 --approve
# Perform approved maintenance separately.
python3 deploy/cutover.py recovery resume --node spark-3eb0 --approve
python3 deploy/cutover.py recovery uninstall --node spark-3eb0 --approve
```

Omit `--node` to select both inventory nodes. Use the existing global `--config`
option for an alternate production inventory. No Cloudflare API operation is
performed. `status` is read-only and exits nonzero if jobs are missing, checksums
are invalid, or the deployed version differs from this checkout. It reports
maintenance pause separately; it does not establish app or replication health.

Installation requires existing initialized databases, expected roles, pinned
local images, valid Compose configuration, the private interface, and an
already-active/enabled cron service. It installs no host prerequisites. It
validates without starting services, stages and atomically publishes the helper
and manager, records their SHA-256 hashes, backs up replaced files and crontab
with private permissions, and installs exactly one project-owned cron entry.
Repeated installation is a no-op when source, checksums and schedule match. The
18 October legacy jobs are adopted rather than duplicated. Unknown/conflicting
jobs fail closed. All unrelated cron entries are preserved. There is no atomic
transaction across two hosts: on partial failure, inspect status and retry the
failed node. A crontab write failure rolls back replaced sources; detected
concurrent crontab edits are not overwritten during rollback.

The application-owned user crontab runs the integrity-checking manager every
two minutes using the existing cron service:

```cron
*/2 * * * * /usr/bin/python3 /home/lab/cursus-production/deploy/recovery.py --local --env-file /home/lab/cursus-production/.env.production --role primary --project cursus-production-primary run 2>&1 | /usr/bin/logger -t cursus-boot-recover # cursus-recovery:cursus-production-primary
```

The secondary uses its own role/project from the existing inventory. This
does not modify Docker, networking, host packages or machine provisioning.
It runs after reboot without relying on an interactive login or user linger.
Monitor `journalctl -t cursus-boot-recover` and public readiness: cron is recovery,
not alerting or an HA guarantee. Host log retention remains host-managed.
Installation verifies staged checksums **before** executing the prerequisite
helper. The returned database identity is recorded in `.boot-recover.json`;
subsequent installation and runtime checks require that identity to remain the
same. A legitimate database relocation/replacement requires a separately reviewed
identity transition, not automatic recovery or silent manifest repinning.

The scheduled manager verifies both files against `.boot-recover.json` before
executing the helper. Missing manifests or tampering fail closed and log an
error. This protects against accidental drift, not a hostile Docker/host admin.
Reinstall from the approved checkout to update pinned helper versions. Do not
edit installed scripts directly.

Use `pause` before intentional maintenance; it waits for any in-flight helper
to finish and creates `.boot-recover-paused`. The helper rechecks that flag after
acquiring the same lock, so a process launched before pause cannot cross the
maintenance boundary afterward. `resume` revalidates prerequisites
and integrity before removing it. Approved cutover pauses each node before
activation and resumes only after origin health passes; a failed cutover leaves
that node paused for operator review. Other manual update procedures must pause
explicitly. Otherwise recovery restarts intentionally stopped services too.
`uninstall` removes only the owned schedule; source, manifests, backups, database
volumes and pause state are preserved. It does not stop any service.

No reboot recovery can protect against failed disks, a missing private network,
corrupt data, or loss of the controller's own host scheduler. This is bounded,
fail-closed reconciliation, not automatic database HA or a claim that catastrophic
reboot recovery has been proven.

## Interrupted operations and timeouts

Each helper run has a 150-second total command deadline; the manager bounds its
helper invocation at 180 seconds. A single command is additionally limited to
120 seconds. Local helper processes and their ordinary descendants share an
owned process group. Timeouts and exceptional exits kill/reap that group before
the manager returns, including descendants that detached their output streams.
Deliberately daemonized processes and work already accepted by the Docker daemon
are not cancellable by killing a client.

Before any mutating Compose command, recovery durably creates
`.boot-recover-uncertain`. It removes the marker only on successful completion.
Timeout, failure or crash leaves it in place. Subsequent cron runs refuse writes;
status exits nonzero and reports `uncertain_operation`. Pause still sets the
maintenance flag but reports an error rather than asserting that maintenance is
safe while a Docker operation remains unresolved. Resume/installation also fail
their prerequisite checks until an operator resolves it.

To resolve: keep recovery paused, inspect Docker events and all affected container
states/mounts/image identities, readiness, PostgreSQL roles and replication, and
confirm no prior reconciliation is still running. Only after that explicit
operator review remove the exact `.boot-recover-uncertain` marker in that node's
deployment directory, then run `recovery resume` and verify status/readiness.
Never clear it automatically merely because a timeout elapsed. A full host reboot
during a write may therefore require manual review instead of blind automatic
retry. This deliberate fail-closed boundary trades recovery convenience for
database and maintenance safety.

Streaming replication uses a physical slot with bounded retained WAL (16 GiB
maximum, plus 512 MiB `wal_keep_size`). Monitor slot `wal_status` and lag: a long
outage can exceed retention and require operator recovery. No fixed RPO is
guaranteed by asynchronous replication. The standby has `restore_command`
`cp /backup/wal/%f %p`; required verified archive files must already be available
in its local backup mount. This is not automatic off-node archive distribution.
If WAL is missing, recover from verified archives, or separately approve a
standby rebuild. Never automatically reseed or promote.

Test the helper twice for idempotency, then stop only the secondary app and run
it again to prove restart recovery while primary serves traffic. A full host
reboot also affects unrelated workloads and requires separate coordination;
container-level recovery tests do not establish host-reboot success.
