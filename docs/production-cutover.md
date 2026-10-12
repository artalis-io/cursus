# Production deployment and cutover

This runbook implements PR #12's three separately approved stages. It does not
change the adopted Cloudflare load balancer, tunnels, monitor, SSH ingress, or
Resend DNS. Before the final stage, both production candidates listen only on
isolated loopback ports (`18101` and `18102`); the temporary Hello World servers
continue to own port `8080` and public traffic.

The machine-readable inventory is [`deploy/production.json`](../deploy/production.json),
the production environment template is [`.env.production.example`](../.env.production.example),
and the controller is [`deploy/cutover.py`](../deploy/cutover.py). Generated
evidence under `deploy/reports/` is operational data and is Git-ignored.

## Safety and ownership

- Herding Sparks continues to own host provisioning, Docker, SSH, tunnel
  connectors, and machine security. The controller never restarts cloudflared.
- Cursus owns its Compose project and its existing LB origins. A drain changes
  only the selected adopted origin's `enabled` field, preserves unknown pool
  fields, rereads before mutation, and verifies the update.
- Production PostgreSQL remains asynchronous primary/standby. A zero-lag sample
  is not a hard RPO guarantee. There is no automatic promotion. Manual
  promotion remains fail-closed without independent fencing evidence.
- The production R2 bucket and token must be dedicated and bucket-scoped. The
  tool validates mounted credentials through application readiness; it never
  prints or commits them and does not manage email DNS.
- Every mutating command has a distinct approval flag. Approval for one stage
  does not authorize any later stage.

## One-time node preparation

At the provisioning approval boundary, install an identical checkout and
locally built image on each node at `/home/lab/cursus-production`. Initialize
submodules and copy `.env.production.example` to `.env.production` with mode
`0600`. Use `cursus-production-primary`/port `18101` on `spark-7468` and
`cursus-production-secondary`/port `18102` on `spark-3eb0`. Set each node's
private PostgreSQL address and role-specific database URL. Do not reuse staging
projects, directories, database credentials, ports, or R2 bucket/token.

Secret files under the node's production secret directory must contain the
PostgreSQL passwords/URL, R2 access key, R2 secret, Resend key, and
authentication allowlist. Bind-backed Compose secrets preserve host ownership:
files read by Cursus are therefore owned by UID/GID 10001 and files read by
PostgreSQL are owned by UID/GID 70, all mode `0400`. The production env file is
owned by the operator and mode `0600`. The allowlist remains external and must
not be copied into this repository. Customer data and OSM assets remain
external mounts; normal runtime mounts them read-only.

On the controller, keep the production R2 identity separate from staging in
`~/.config/cursus/production-r2-access-key-id`,
`~/.config/cursus/production-r2-secret-access-key`, and
`~/.config/cursus/production-r2-bucket`, all mode `0600`. The last file contains
only the production bucket name. Never overwrite or reuse the staging token.

The Compose file retains the historical variable name `CURSUS_STAGING_PORT` for
backward compatibility with the tested PR #11 contract. In a production env it
means the loopback application port. Activation changes its one exact env-file
entry to `8080`, retaining a `.bak` copy on the node.

## Read-only preflight (execute immediately)

```bash
python3 deploy/cutover.py validate
python3 deploy/cutover.py preflight > /tmp/cursus-production-preflight.json
python3 deploy/ha.py plan
python3 deploy/ha.py status
python3 deploy/ha.py test
```

Preflight reports architecture, Docker/Compose versions, capacity, tunnel
service state, port-8080 readiness, and the exact temporary-server PID without
printing credentials or application environment. It records no mutation.

## Gate 1: provision

Do not run this command until provisioning has explicit approval. The checked-in
`deploy/recovery-adapter.py` receives `--stage recovery --nonce VALUE`.
It must take a production backup, restore it into an isolated target, validate
the restored database, and print one JSON object to stdout:

```json
{
  "success": true,
  "nonce": "the supplied nonce",
  "backup_id": "immutable backup identifier",
  "restore_verified": true,
  "database_timeline": 1,
  "rpo_observation": "recorded by adapter",
  "rto_seconds": 123
}
```

Then run:

```bash
python3 deploy/cutover.py provision \
  --approve-provision \
  --recovery-adapter ./deploy/recovery-adapter.py
```

The command validates both remote env files and Compose configurations, starts
the primary then standby and both candidate applications, and refuses success
unless both candidates are ready, their image IDs match, PostgreSQL roles are
correct, one standby is connected, observed byte lag is zero, and the recovery
drill passes. It writes `deploy/reports/production-provision.json`. It does not
touch port `8080` or Cloudflare.

## Gate 2: migration and write freeze

Migration requires separate explicit approval. Before copying authoritative
state, freeze legacy writes and record signed/operator-controlled evidence in a
local JSON file containing at minimum:

```json
{
  "frozen": true,
  "authority": "operator or change ticket",
  "snapshot": "immutable source snapshot/checksum"
}
```

The migration adapter receives `--stage migration --nonce VALUE`. It is
deployment-specific because the source may be legacy JSON/SQLite or an approved
staging snapshot. It must import tenant/auth/scenario/job metadata, admit or
reference immutable R2 artifacts, validate row/object checksums and tenant
ownership, and print matching successful JSON. It must not silently infer a
source or overwrite an existing production tenant.

```bash
python3 deploy/cutover.py migrate \
  --approve-migration \
  --freeze-evidence /secure/change/cursus-write-freeze.json \
  --adapter /absolute/path/to/migration-adapter
```

The result is `deploy/reports/production-migration.json`. Keep writes frozen
until cutover succeeds or the rollback decision explicitly returns authority to
the old system.

## Gate 3: activate

Activation requires separate explicit approval and both prior evidence files.
Immediately before running it, review the recovery evidence, migration counts
and checksums, database lag, image IDs, local candidate readiness, and
`python3 deploy/ha.py plan`.

```bash
python3 deploy/cutover.py activate --approve-cutover
```

The controller processes the secondary first and then the primary:

1. reread the adopted pool and drain exactly that origin;
2. verify and terminate only the exact `python3 /tmp/cursus-hello.py` process;
3. persist port `8080` in that node's production env and recreate only Cursus;
4. require local application readiness;
5. restore and verify the origin in `finally`;
6. repeat on the peer and verify public readiness.

It never uses generic `pkill`, stops a tunnel, or disables both origins at once.
If a node fails before readiness, it removes that failed Cursus container,
restores the candidate port, starts the allow-listed temporary server, and then
restores the origin. The operator must inspect any partial result before retry.

## Rollback and database compatibility

Application rollback uses the PR #11 rolling workflow and a previous immutable
image only while that image's declared schema range includes the current schema.
Migrations must use expand/contract: release N and N-1 remain compatible for the
whole rolling window, destructive contraction occurs only in a later release,
and ordinary rollback never restores a database backup.

A database restore is disaster recovery. Keep writes disabled, independently
fence any former primary, restore the matched backup/WAL set into isolation,
validate timeline and object references, then reopen authority deliberately.
Never promote merely because SSH is unavailable.

After activation verify local and public readiness, authentication, a small
stateful read/write workflow, cross-replica retrieval, R2 access, outbox state,
replication lag, backup scheduling, and Cloudflare pool health. Preserve the
machine-readable reports with the change record rather than Git.
