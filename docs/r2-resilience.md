# R2 connection and readiness resilience

The stateful runtime bounds storage work so a network stall cannot accumulate unlimited requests or indefinitely hold readiness open. These changes do not establish the precise cause of the November 3 production incident. That incident showed a primary app waiting on its R2 client, socket-capacity warnings and successful recovery following an app restart; the secondary remained available.

## Transport contract

| Operation | Limits per application process |
|---|---|
| Data operations | 8 active operations, 16 waiting; additional calls fail promptly with HTTP 503 (`busy`) |
| Data deadline | 300 seconds total, including admission wait, all SDK attempts, HEAD/PUT reconciliation, body consumption and pagination |
| Data transport | 2-second connection timeout, 15-second idle socket timeout, at most 3 standard SDK attempts per command within the total deadline |
| Readiness | Separate agent with one socket, one attempt and 2-second total deadline; connections are not reused |
| Probe sharing | All overlapping callers await one probe; successful results cached for 2 seconds, failures for at most 1 second |
| Database readiness | 1.5-second client query timeout, followed by the bounded R2 probe |

Initial limits are explicit constructor defaults. Changing them requires a reviewed application release; no extra deployment secrets or environment variables are needed. Limits apply per replica, not globally across the cluster. Existing solver concurrency, leases and fencing remain authoritative.

The data deadline covers response-body consumption, not just response headers. Abort destroys a stalled download stream and releases its admission slot; a rejected or expired waiter is removed from the queue. A subsequent operation opens a usable connection without restarting the process. Shutdown closes both clients, aborts in-flight operations and rejects queued calls. Storage unavailable at startup still fails startup, allowing the existing Compose restart policy to retry.

Readiness returns 503 when the probe fails and retries after its short failure cache expires. It never continues to return a stale success after that cache expires. `/api/health` remains liveness. Readiness sets `Cache-Control: no-store` and retains the exact `"status": "ready"` fragment required by the adopted Cloudflare monitor. Storage failures include only a generic dependency and allowlisted code. Do not bypass this dependency check or promote PostgreSQL to resolve an R2 failure.

## Immutable artifacts and publication

Uploads retain checksum-addressed tenant keys, SHA-256 metadata and `If-None-Match: *`. Existing metadata and size must match before reuse. A conditional conflict from a concurrent writer is reconciled by another HEAD and admitted only if its metadata matches. A lost upload acknowledgement fails the operation; retry may discover and verify the already-written object. No path overwrites an existing object. Downloads still verify both SHA-256 and size before returning bytes. Incomplete listing metadata fails rather than presenting a partial inventory as complete.

This layer writes immutable objects only. Dataset admission and solver-result publication continue to require their existing PostgreSQL transaction and current fencing generation; failed storage operations cannot make partial artifacts authoritative. Orphan retention/deletion policy is unchanged.

## Operational signals and recovery

The runtime emits structured JSON records with `component: object-storage`:

- `unavailable`: readiness changed to failed; alert on repeated readiness 503s or both origins failing.
- `recovered`: a new probe succeeded after failure; verify recovery and object operations.
- `operation-failed`: data operation failed, rate-limited to one record per 30 seconds per process. `timeout`, `busy`, `unavailable` and `integrity` distinguish deadline, load, provider and checksum failures.

Records include aggregate completed/failure/timeout/rejection/probe counters, active and pending operation counts, readiness state and age of the last successful probe. They contain no endpoint, bucket, object key, tenant, customer content, credentials or raw provider error. Shutdown cancellations do not emit outage alerts. `ObjectStore.diagnostics()` exposes the same in-process snapshot for diagnostic tooling; no new public metrics endpoint is added.

For `busy`, inspect job concurrency and operation duration before increasing limits. For `timeout`/`unavailable`, check connectivity, R2 service status and credential validity; a later successful probe restores readiness automatically. For `integrity`, preserve evidence and investigate the reference/object mismatch; do not replace the object or disable validation. Both origins unavailable means storage-dependent workflows are unavailable even if PostgreSQL is healthy. These records are actionable signals; external alert delivery remains owned by the deployment monitoring system.

## Verification

`npm --prefix server run test:ci` includes real loopback HTTP tests using the actual S3 SDK. They exercise 200 simultaneous hung readiness callers, failure/success cache behavior, recovery without restart, socket closure after deadlines, bounded data admission, independent health capacity, stalled response bodies, conditional conflicts, lost PUT acknowledgements, retry limits, permission errors, checksum/size rejection, pagination, shutdown and real Fastify readiness responses. Fixtures contain no private data and make no production requests.

The existing PostgreSQL/S3 integration suite checks admission, immutable artifact reuse and fenced publication. CI also runs the full production-image Playwright suite against two replicas. No production rollout is performed by these tests.

Transport configuration follows the [AWS SDK max-socket guidance](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/node-configuring-maxsockets.html) and [HTTP handler configuration](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-client-constructors.html). The total abort deadline additionally bounds socket acquisition, retry backoff and response-body work.
