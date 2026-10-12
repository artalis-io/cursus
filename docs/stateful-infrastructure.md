# Stateful infrastructure implementation

This is a pre-deployment implementation milestone. It adds persistence and
coordination primitives plus a local integration environment; it does not switch
the production application from its JSON/SQLite stores and does not deploy any
service.

## Implemented boundary

- `server/migrations/001_stateful.sql` defines tenant-keyed scenarios, plans,
  identity/session/audit records, immutable object metadata, datasets, durable
  jobs, leases/fences, and the email outbox.
- `server/src/state/postgres.ts` serializes migration with a transaction-scoped
  advisory lock, implements optimistic revisions, idempotent enqueue,
  `FOR UPDATE SKIP LOCKED` claims, expiring leases, monotonic fencing, and atomic
  fenced plan publication.
- `server/src/state/objects.ts` is deliberately narrow: checksum-addressed
  immutable put and verified get through the S3 protocol.
- `server/src/state/outbox.ts` leases delivery intents and sends to Resend with
  the persisted `Idempotency-Key` header.

Cloudflare **R2**, not AWS-hosted storage, is the production target. Configure
the S3 client endpoint as:

```text
https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com
```

Use a private R2 bucket and bucket-scoped R2 API token. The AWS SDK package is
only the maintained S3 wire-protocol client used by R2; it does not select AWS
or require an AWS account. Credentials remain external secrets. The Compose
integration fixture uses SeaweedFS only to test the protocol locally.

## Fencing guarantee

A claim increments `fence`. Heartbeat, failure, and completion predicates all
require tenant, job ID, owner, current fence, running state, and an unexpired
lease. `completeSolve` verifies that predicate and inserts the authoritative
plan in the **same PostgreSQL transaction**. A worker whose lease expired cannot
publish even if its node-local solver later succeeds.

## Email ambiguity

The outbox provides durable intent, not exactly-once delivery. Resend supports
idempotency keys for 24 hours. Every retry reuses the same key and identical
persisted payload. Transient, rate-limit, and ambiguous network failures retry
with bounded exponential backoff; permanent provider rejection is terminal.
Automatic retries stop by 23 hours, so the application does not silently resend
after the provider's deduplication window. An operator must resolve older
ambiguous failures explicitly.

## Local integration

Use a unique project name so this environment cannot join or remove the normal
Cursus project:

```bash
docker compose -p cursus-stateful-test -f compose.integration.yaml up -d --wait
cd server
CURSUS_TEST_DATABASE_URL=postgres://cursus:integration-only@127.0.0.1:55432/cursus \
CURSUS_TEST_S3_ENDPOINT=http://127.0.0.1:59000 npm run test:stateful
cd ..
docker compose -p cursus-stateful-test -f compose.integration.yaml down -v
```

Two independent connection pools prove:

- stale scenario revisions conflict;
- idempotent enqueue creates one job and concurrent claims select one worker;
- a stale fence cannot publish a plan;
- a stale email sender cannot acknowledge another sender's lease;
- outbox enqueue is idempotent;
- immutable objects are checksum addressed and verified;
- dataset publication is transactional and rejects missing objects.

## Deliberately not yet wired

Existing HTTP handlers, filesystem store, solver queue, dataset admission, and
SQLite auth remain the active runtime path. Switching them requires explicit
data migration, compatibility reads, worker lifecycle integration, R2
provisioning, backup/restore, and rollout work in later milestones. This PR does
not make current Cursus safe to deploy active-active and does not alter the
single-writer restriction in `docs/stateful-deployment.md`.

The SQL queue follows PostgreSQL's documented queue use of
[`SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html). Resend's
[idempotency documentation](https://resend.com/changelog/idempotency-keys)
defines the 256-character key and 24-hour retention behavior used here.
