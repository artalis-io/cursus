# Stateful Cursus deployment design

Status: design milestone; no deployment or migration is authorized by this
document. The machine-readable inventory is
[`deploy/stateful-inventory.json`](../deploy/stateful-inventory.json).

## Decision summary

Current Cursus is safe as a **single writer only**. Starting identical processes
on both Sparks is not safe even though Cloudflare prefers the primary. The
secondary would still initialize and garbage-collect its store, accept direct
requests, run local queues, and write independent state. Cloudflare routing is
not application leadership.

The simplest credible target is:

- stateless Cursus HTTP processes on both Sparks;
- one logical PostgreSQL writer for authoritative metadata, auth, revisions,
  job leases, audit, and the transactional email outbox;
- private Cloudflare R2 storage for immutable raw uploads and admitted dataset artifacts;
- versioned OSM assets mounted read-only and identical on both nodes;
- node-local solver work directories and rebuildable geometry/geocoding caches;
- workers claiming durable jobs with leases and fencing tokens;
- initially manual, fenced PostgreSQL failover with tested backups and promotion.

Two Sparks cannot provide a safe automatic database election by themselves. A
two-member synchronous system loses availability on either failure; an
asynchronous automatic promotion can split-brain during a partition. Automatic
database HA therefore requires a third independent voting failure domain or a
managed PostgreSQL service. Until then, routing can fail over automatically but
database promotion must be deliberate and fenced.

## Evidence from the current code

### Persistence

| State | Current implementation | Concurrency finding | Target |
|---|---|---|---|
| Scenarios, plans, jobs | JSON in `DISPATCH_DATA_DIR`; in-memory `Map`s in `store.ts` | Atomic rename prevents a torn single-file write, but there is no cross-process lock, revision CAS, or cache invalidation | PostgreSQL, tenant-keyed, transactional |
| Solver request | `jobs/*_request.json` | Safe only as node-local scratch owned by one leased job | Node-local work directory |
| Raw uploads | Files in `DISPATCH_UPLOADS_DIR` | A later request routed to the other node cannot find the upload; deletion races | Immutable object key plus DB metadata |
| Admitted datasets | Directory tree plus `manifest.json`; registry scans disk | Publish/delete is not transactional across nodes | Object artifacts plus transactional DB manifest |
| Road geometry | In-memory map plus fully rewritten `geocache.json` | Two writers lose entries; cache is rebuildable | Independent bounded cache per node |
| Geocoding cache | OTTO tool writes `GEOCODE_CACHE_DIR` | Tool-level cross-host locking is not established | Per-node cache initially |
| Customer source | External read-only dataset | Safe if immutable identity/checksum matches | Shared read-only or verified copies |
| OSM indexes | Versioned, prepared out of band | Runtime read-only is safe | Identical checksum, read-only on both nodes |

The store constructor loads files into memory, marks every pending/running job
failed, and runs retention GC. If a second process shares the directory it can
invalidate a live job owned by the first and later serve stale maps. If each
Spark uses a local directory, state simply diverges. A network filesystem does
not repair these semantics and is not the recommended shortcut.

Pending authentication PR #6 introduces a SQLite WAL database for users,
memberships, magic links, sessions, and audit events. SQLite is appropriate for
one node, but separate copies split identity/session state and SQLite on a shared
network filesystem is not the target. Those tables should move to the same
PostgreSQL consistency boundary before two application writers are enabled.

### Background work and external side effects

There is no separate worker today:

- Solve requests enter a process-local array. Child handles, timeout timers,
  cancellation, and concurrency counters exist only in that process.
- Dataset admission starts a detached promise guarded by a process-local
  semaphore. It performs geocoding, matrix generation, filesystem publication,
  registry updates, and baseline construction.
- Retention GC runs on startup and after local count thresholds, deleting files.
- There is no cron scheduler or message broker.
- Pending PR #6 creates a magic-link row and calls Resend inline. A crash or HTTP
  retry can separate database state, delivery, and audit state.

The target job state machine is `queued -> leased -> succeeded|failed|cancelled`.
Claim uses one PostgreSQL transaction (`FOR UPDATE SKIP LOCKED` or equivalent),
records `lease_owner`, `lease_expires_at`, attempt, and a monotonically
increasing fencing token. Only the current token may heartbeat or publish the
result. All mutating API operations accept/derive an idempotency key. A solver
child remains node-local, but its durable job is visible to either worker.
Cancellation sets durable intent; the lease owner kills its child and confirms
terminal state. Expired work is retried only when the operation is retry-safe.

Resend uses a transactional outbox: token/challenge and a uniquely keyed email
intent commit together. A leased sender submits the intent with a stable
provider idempotency key and records the provider result. This gives at-least-once
processing with deduplicated external effect rather than an unsafe promise of
exactly once.

## Concurrency conclusions

Both current application instances may safely serve only immutable/static or
strictly read-only data whose identity is equal. They may not both accept
scenario edits, uploads, admission, solves, deletes, authentication changes, or
email requests. Process-local rate limits also double the effective global
allowance, which is acceptable initially if documented but is not a security
quota.

PostgreSQL migration alone is insufficient: every record must carry `tenant_id`;
scenario edits need optimistic revision checks; jobs need leases/fencing;
artifacts need immutable publication; caches must not be shared writable; and
the application must stop treating startup as ownership of all running jobs.

## Failure semantics

| Failure | Required behavior | Data-loss boundary |
|---|---|---|
| Cursus process/node dies | Cloudflare routes elsewhere; its job lease expires; another worker retries only retry-safe work | No committed DB/object state lost; local scratch/cache discarded |
| Solver child dies/times out | Owner records failure or retry decision using fencing token; stale child cannot publish | No plan is visible without atomic completion |
| Worker partitioned from DB | Readiness fails for mutation capability; worker stops claiming/heartbeating and cannot publish after lease loss | Work may repeat, never commit twice |
| Object store unavailable | Upload/admission endpoints fail closed; existing DB row is not published without verified object | No manifest points at a partial object |
| PostgreSQL primary fails | Applications become unready for authoritative operations; operator fences old primary, measures replica lag, promotes secondary, redirects clients, verifies, then restores service | With async replication, acknowledged transactions within measured lag can be lost; document RPO |
| Network partition between Sparks | No automatic DB dual-primary promotion; only the fenced writer remains authoritative | Availability may be sacrificed to prevent split brain |
| Resend unavailable | Outbox retains retryable intent with bounded backoff; UI response does not create another logical intent | Delayed email, not duplicate token creation |
| Deployment/migration fails | Old app remains compatible during expand/contract; rollback app without reversing destructive schema changes | No destructive migration in same release |
| Both nodes/storage lost | Restore PostgreSQL and object store from matched, tested backup set; verify checksums before reopening writes | Declared backup RPO/RTO |

Readiness must be dependency-aware but avoid cascading on optional services.
Proposed endpoints/modes:

- `/health/live`: process is alive; no dependency calls.
- `/health/ready`: safe to receive normal Cloudflare traffic for the configured
  role/version, including DB schema compatibility and required immutable assets.
- deployment status: version, schema compatibility, writer/worker acceptance,
  outstanding leases, and object-store reachability, without secrets or customer
  contents.

## Deployment and migration sequence

Each numbered stage is a separate, reversible PR where practical.

1. **Contracts and observability.** Add the health modes, immutable build/version
   identity, structured migration/job metrics, and tests. Keep one application
   writer. Extend `deploy/ha.py status` to display version/schema/role only after
   the app exposes them.
2. **PostgreSQL persistence.** Define tenant-keyed schema for scenarios, plans,
   jobs, auth, audit, and outbox. Add repository interfaces and dual-read
   comparison tooling. Migrations take a PostgreSQL advisory lock and use
   expand/contract changes. Import existing JSON/SQLite once with checksums and
   an explicit cutover; never silently migrate at startup.
3. **Artifact storage.** Introduce an object-store interface. Upload to a unique
   staging key, checksum it, then transactionally publish the manifest. Existing
   customer source and OSM assets remain separate read-only inputs.
4. **Durable workers.** Move solve/admit/email execution behind DB jobs, leases,
   fencing and idempotency. Test crash-after-claim, lease expiry, duplicate
   submit, cancellation, stale completion, and Resend retry.
5. **Two stateless app replicas.** Deploy the same pinned ARM64 digest to both
   Sparks against the one logical DB/object store. Initially run worker
   concurrency conservatively. Prove session continuity and read/write-after-
   failover through the public endpoint.
6. **Rolling deployment command.** Only then add a controlled command to
   `deploy/ha.py`: verify peer readiness/capacity, disable (drain) one existing
   pool/origin through an approved Cloudflare update, deploy by an explicit
   adapter, wait for app version/schema readiness, restore and verify, then
   repeat. It must restore routing in `finally`, stop before incompatible schema
   transitions, and never use failure detection as planned draining.
7. **Database recovery, then HA.** Automate backups and regularly restore them.
   Establish fenced manual promotion and measure RPO/RTO. Add automatic
   PostgreSQL failover only after introducing a third voting failure domain or a
   managed service and running partition tests.

## Rolling upgrade and rollback contract

- Images are immutable, pinned by digest, native ARM64, and identical on nodes.
- Database migrations are a separately visible job, serialized by advisory lock;
  application startup never performs an unbounded implicit migration.
- Release N and N-1 must operate during the rolling window. Add columns/tables
  before use; backfill asynchronously; switch reads/writes; remove only in a
  later release.
- Drain means Cloudflare stops new traffic and the app stops accepting new jobs;
  existing HTTP and leased work get a bounded grace period. Long solver work is
  either completed or deliberately returned to the durable queue.
- Rollback changes the application digest, not the database backup. A database
  restore is disaster recovery, not ordinary rollback.
- Deployment success requires correct digest, compatible schema, ready peer,
  no stale leases from the node, and public plus node-local checks.

## Validation gates before production deployment

- Repository/worker integration tests against real PostgreSQL transactions.
- Concurrent edit tests proving revision conflicts rather than lost updates.
- Duplicate job and stale-fencing-token tests.
- Upload publish/interruption/delete races against the chosen object store.
- Magic-link consume and Resend outbox retry/idempotency tests.
- Backup plus bare restore rehearsal with recorded RPO/RTO.
- Node kill, worker kill, DB disconnect, object-store outage, and network
  partition exercises in a non-production environment.
- Rolling N/N-1 compatibility and rollback rehearsal.

Until these gates pass, keep the real Cursus application single-writer and do
not replace both Hello World origins with independently writable instances.
