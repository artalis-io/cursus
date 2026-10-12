# Stateful deployment infrastructure

This is the PR #11 staging contract. It does not activate production, alter
Cloudflare, bind port 8080, migrate legacy data, or provision an R2 bucket.
`deploy/stateful.json` reuses the SSH node inventory from `deploy/ha.json` and
assigns isolated project names and loopback application ports 18091/18092.

## Safety boundary

- Staging projects, ports, directories, PostgreSQL clusters, passwords and R2
  buckets must be distinct from production. `deploy/stateful.py validate`
  rejects port 8080, the production Compose project name and inventories that
  diverge from the existing HA node list.
- The current Hello World processes and Cloudflare tunnels continue to use
  `127.0.0.1:8080`. Staging binds only its configured loopback port.
- Customer uploads enter the application over HTTP and are written directly to
  the configured staging R2-compatible bucket. They are never an image input.
- `compose.stateful.yaml` uses explicit host bind mounts with
  `create_host_path: false`; operators create and permission only reviewed
  staging paths.
- Container UIDs are deliberate: Cursus and the preparation job use 10001,
  OTTO's distroless Velo/Carta images use 65532, and PostgreSQL recovery jobs
  use 70. Prefer POSIX ACLs over world-writable directories. For example,
  grant UID 10001 write access to state/OSM preparation, UID 65532 read and
  traverse access to prepared public OSM assets, and UID 70 write access to
  PostgreSQL data/backup/restore paths. `osm-prepare` makes its published
  public version tree readable while leaving customer and database data alone.
- PostgreSQL and R2 credentials are file-backed Compose secrets rather than
  container environment values. Use a bucket-scoped token for
  a dedicated non-production bucket. Configuration validation does not write to
  R2; the Gyermelyi exercise necessarily writes immutable objects to staging.
- The authentication allowlist and Resend key are also file-backed secrets.
  The example keeps auth disabled for loopback-only staging; enabling it
  requires an appropriate staging public origin. Email addresses never belong
  in the env file or repository.

## Image and runtime contract

The application Dockerfile builds the web application, server, Nexus,
`matrix_build` and Surge from the checked-out Cursus/OTTO revisions. Node,
Debian and PostgreSQL manifests are pinned. Velo and Carta continue to use
OTTO-owned Dockerfiles from the pinned `vendor/otto` submodule; Cursus does not
duplicate them.

ARM64 and AMD64 artifacts are architecture-specific and are not expected to be
bit-identical. A release report records the Cursus revision, OTTO revision,
platform and local image IDs. On the two ARM64 Sparks, build the application
once and transfer it with `docker save`/`docker load` so both nodes run the same
image ID without publishing an application image.

Stateful mode starts `server/dist/stateful-runtime.js`, runs migrations under a
PostgreSQL advisory lock, verifies the object-store bucket, serves the SPA and
API, and runs durable solve, conversion and email-outbox loops. Both replicas
may claim work; leases and fencing govern publication. `/health/ready` returns
200 only while PostgreSQL and object storage are reachable.

`CURSUS_DATASET_PATH` points to the existing external customer dataset on each
node. Compose mounts it read-only; it is never copied into the repository,
Docker build context, application image, or writable Cursus state. Customer
datasets and the separately mounted OSM assets remain distinct input classes.

The initial limits in `.env.stateful.example` are deliberately generous on a
128 GiB Spark. Expensive solve and conversion concurrency defaults to one per
replica. Replace ceilings only after the deployment report captures measured
peaks; the health endpoint remains in the application process and is not queued
behind native jobs.

## PostgreSQL replication and recovery

Run the primary and standby profiles on different nodes:

```bash
docker compose --env-file .env.stateful -f compose.stateful.yaml \
  --profile database-primary up -d postgres
docker compose --env-file .env.stateful -f compose.stateful.yaml \
  --profile database-standby up -d postgres-standby
```

The primary initializes a SCRAM replication role and permits replication only
from `CURSUS_REPLICATION_CIDR`. The standby refuses to overwrite a non-empty,
uninitialized data directory and otherwise clones with `pg_basebackup -R`.
Normal application failover and database recovery are separate: loss of the
primary interrupts writes until an operator completes a fenced promotion.
The primary bind address must be its trusted private interface. Confirm the
actual source address with a rejected connection before selecting the narrow
replication CIDR: routed networks may source-NAT the standby. Never replace a
verified host `/32` with a broad subnet merely to make replication connect.

Create a base backup and prepare an isolated restore with:

```bash
docker compose --env-file .env.stateful -f compose.stateful.yaml \
  --profile backup run --rm postgres-backup
docker compose --env-file .env.stateful -f compose.stateful.yaml \
  --profile restore run --rm postgres-restore
```

The backup job shares the already-running primary's network namespace and
connects through loopback; it does not need an additional HBA grant. It runs as
PostgreSQL UID 70 and stages each base backup under a hidden temporary name,
publishing `latest` only after the backup and completion record are durable.

WAL is archived under `CURSUS_POSTGRES_BACKUP_PATH/wal`; base backups and their
manifests are under `base/<UTC-ID>`. Restore refuses a non-empty target. Set
`CURSUS_RECOVERY_TARGET_TIME` for PITR. Start the restored directory on a new,
isolated port and validate application invariants before using it. Backups are
not proven until this restore test passes. Copy backup material to a separate
failure domain; a local disk copy does not survive loss of its Spark.

Schema changes must be backward compatible for the documented application
compatibility window. Rolling rollback may select an older image only while
its declared schema range includes the current migration version. Irreversible
changes require forward repair or restore into a new cluster; deployment tools
must never attempt automatic down-migrations.

## Manual promotion and fencing

Promotion fails closed:

```bash
CURSUS_FENCE_COMMAND=./deploy/fence-docker-ssh.py \
  ./deploy/stateful.py promote --approve --report /secure/path/promotion.json
```

The adapter must return matching nonce-bound JSON proving the former primary is
isolated by an identified authority. SSH failure is never isolation evidence.
The included staging adapter works only when the old node is reachable: it sets
the PostgreSQL container restart policy to `no`, stops it, and verifies both
facts. Thus Docker daemon or host restart cannot automatically revive the old
writer. If it cannot perform that operation, promotion is refused. An
independent Herding Sparks power/network fence may replace it using the same
contract and is required for promotion during an unreachable-node incident.

After promotion, the former primary must never simply be restarted. Re-clone it
from the new timeline as a standby. The promotion report records fencing
authority/evidence and the promoted timeline/WAL position.

## Deployment operations

```bash
./deploy/stateful.py validate
./deploy/stateful.py status
./deploy/stateful.py report --output /secure/path/deployment-report.json
```

After the same labeled image has been loaded on both nodes, the guarded command
updates the secondary first, requires readiness, and then updates the primary:

```bash
./deploy/stateful.py rollout --image cursus-app:REVISION --approve
./deploy/stateful.py rollback --image cursus-app:PREVIOUS_REVISION --approve
```

Both operations are restricted by the checked-in staging inventory, require an
explicit approval flag, use `--pull never`, and reject images whose declared
schema compatibility does not include migration version 1. A rollback is not a
database down-migration.

Before deployment, snapshot `deploy/ha.py plan`, both port-8080 listeners and
the Hello World process/container state. After staging, repeat those reads and
require an exact match. Do not run `deploy/ha.py apply` for staging.

Rolling application update sequence:

1. Record the current image ID, migration version and readiness of both nodes.
2. Update the secondary staging replica, wait for `/health/ready`, and execute a
   read plus a durable job through it.
3. Update the primary replica and repeat verification.
4. Roll back only to an image compatible with the current schema. Otherwise
   restore the tested backup into a new isolated cluster and repoint staging.

Teardown uses the exact staging project names and leaves external paths intact:

```bash
docker compose --env-file .env.stateful -f compose.stateful.yaml down
```

Remove staging data or R2 objects only as a separate reviewed operation.

## October 2026 Spark staging evidence

The isolated exercise used loopback application ports 18091/18092 and private
PostgreSQL port 55432; production port 8080 remained occupied and unchanged.
Both nodes loaded the same ARM64 application image ID. Hungary preparation
published identity `ff567f352e56218be6e12d13b08193c94c117973c216c773a176a2f79975139d`
from PBF SHA-256 `8f6533151de80b5e75f2bbebca9f852c1cd19318634e1d0d40337a5ccca4fb3e`;
an immediate second run reused it. The copied PBF, Velo, Carta and Locus files
matched by SHA-256 on both nodes.

With Hungary loaded, each Velo container settled near 5.30 GiB and each Carta
container near 1.09 GiB; PostgreSQL primary/standby used roughly 23--27 MiB.
Both native health endpoints passed on both nodes. Streaming replication
replayed schema migration 1 to the same WAL LSN. A physical base backup was
restored in a network-isolated container, replayed archived WAL, reached a new
timeline, and exposed migration version 1. These figures are observations, not
new tighter limits.

The dedicated non-production R2 bucket was then supplied with bucket-scoped
credentials. Both replicas reached stateful readiness against the shared
PostgreSQL primary and R2. They ran the same ARM64 image ID
`sha256:95d82ebca31a712cc6f67dd1d3df4ff7c2c3950b90bd1e7bff462412f4b0018b`
from Cursus revision `5f7768cdca0f80c41f81e63c4e470189d61cb485` and pinned OTTO revision
`fc4a11b8c58b8921c9b68895692e791b28493a2c`.

A private Gyermelyi CSV was uploaded through the primary API to R2, converted
by Nexus/geocoding/Velo, and observed through the secondary API. Conversion
admitted 275 routable stops across two days from 332 input rows in about 100
seconds; 57 rows were excluded, none were unresolved, and two generated snap
warnings. Native Surge then completed a representative 125-order, 30-second
budget solve in about 35 seconds. The resulting 207,326-byte plan and
27,339-byte handoff export were retrieved from the other replica.

A second native solve was forcibly returned to the queue while generation 1
was executing. The other node claimed generation 2, completed it, and only its
plan was published; the stale execution produced no additional authoritative
plan. At final reporting both databases were on timeline 1 at WAL LSN
`0/B049D70`, both applications were ready, and the production port-8080 guard
retained its original snapshot SHA-256
`1971ae5a30b5e0c05573b8b4387995b85f303fe69392063e64a28f7cdf876b8b`.
The machine-readable evidence is generated outside Git with
`deploy/stateful.py report` and contains no credentials or dataset contents.
The rolling-update command then replaced the standby before the primary and
verified readiness after each step; the rollback command restored the original
tag in the same order. Both tags resolved to the same verified immutable image
ID for this lifecycle-only drill.
