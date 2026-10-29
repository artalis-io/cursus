# Acknowledged integration handoff

Cursus records a durable instruction for an operator-configured receiver. This
is a product integration contract, not a JDE/WAMAS implementation. Customer
adapters translate this contract into their own systems and acknowledgements.
No destination is enabled by default. This implementation does not provision or
contact production systems merely by upgrading Cursus.

## Workflow and authority

The toolbar's **Acknowledged handoff** dialog shows destination, exact plan and
revision, instruction generation, attempts and receipts. Admin can publish an
approved plan, amend a previously accepted instruction with a different approved
snapshot, or cancel the last accepted instruction with a reason and confirmation.
Planner and Reviewer can inspect history and continue downloading ordinary
draft/approved exports; they cannot send, retry or cancel. The backend checks both
the effective permission and current tenant membership at the write boundary.
Operational publish/amend also requires a complete, unique dataset-scoped
delivery inventory. Historical plans missing that identity remain exportable,
but must be replanned before an acknowledged operational handoff.

Queuing uses an operation ID, expected scenario revision, expected destination
generation, exact approval version and previous accepted instruction. Approval
and immutable payload publication share a short scenario transaction. Concurrent
edits or competing sends cannot silently change that snapshot. An amendment is
not a new unrelated dispatch. A rejected amendment preserves the previously
accepted instruction. Cancellation references its exact receipt and plan even
when that plan is now superseded. History prevents deleting its scenario.

The existing PostgreSQL job worker delivers outside database transactions, with
leases, serial heartbeats and fencing at every authoritative completion. The
request body and idempotency key remain identical through retries and worker
takeover. Attempts, receipt, checksums and audit events persist across replicas.
Receiver acceptance means **instruction accepted**, not warehouse completion,
vehicle departure, proof of delivery or successful physical fulfilment.

## Receiver contract: cursus.handoff.v1

Configure a single HTTPS endpoint for POST and GET. Redirects are rejected. POST
has an immutable JSON `TransferEnvelope` (see
`server/src/integration-contract.ts`), Bearer authentication and headers:

- `Idempotency-Key`: persistent unique instruction key.
- `X-Cursus-Payload-SHA256`: SHA-256 of the exact UTF-8 request bytes.
- `X-Cursus-Generation`: monotonic generation for tenant/scenario/destination.
- `If-None-Match: *` for the initial instruction, otherwise
  `If-Match: "<previousReceiptId>"`.

Publish/amend includes the complete approved JSON handoff with constraints,
approved exceptions, delivery identities, dataset and shipment references,
approver and approval timestamp. Cancellation references the previously accepted
plan and receipt without redispatching its routes.

The receiver must atomically persist idempotency key, body hash, receipt and
highest accepted generation **before** acknowledging. Repeated identical keys
return the original receipt; conflicting bytes must be rejected. Older
generations and mismatched previous receipts must never apply. Retain receipts
for the deployment's recovery/history lifetime, not merely a short retry cache.
Receiver side effects need their own transactional/idempotent implementation.

Return a bounded JSON acknowledgement (maximum 64 KiB), with accepted HTTP 2xx:

```json
{
  "status": "accepted",
  "receiptId": "receiver-receipt-123",
  "idempotencyKey": "cursus-<instruction-uuid>",
  "payloadSha256": "<exact-request-sha256>",
  "generation": 1,
  "planSha256": "<plan-sha256-from-envelope>",
  "scenarioRevision": 1
}
```

`status` may be `rejected`; all identity fields must still match. GET to the
same endpoint with the key/hash/generation and authentication must return the
persisted acknowledgement, or 404 if currently unknown. GET never applies an
instruction. A 404 **does not prove a late POST cannot still be accepted**.

## Ambiguity, staleness and recovery

Timeouts, invalid receipts and interrupted attempts retain the same key. Automatic
POST retries use exponential backoff, at most eight claimed attempts within
24 hours of queuing. Before each attempt, approval and endpoint identity are
rechecked. A changed/stale plan is never newly POSTed after that check; if any
attempt already occurred, recovery becomes GET-only. An edit racing with an
in-flight send can still reach the receiver: its receipt is recorded as
`acknowledged_superseded`, and an explicit amendment/cancellation is required.
This protocol cannot retract bytes already sent over the network.

Ambiguous terminal outcomes become `needs_reconciliation` and block a replacement
instruction. Admin may look up a receipt or retry the **same** instruction. After
expiry/attempt cap, even an explicit retry is receipt-only. A negative lookup does
not clear the outstanding intent. Independently reconcile the receiver before
any operator-assisted resolution; there is intentionally no UI "assume failed"
override. Endpoint drift fails closed. Restore the original endpoint identity to
look up an outstanding receipt. Credential rotation keeps endpoint identity.

There is no unconditional exactly-once claim. Safety across lost responses
depends on the receiver's durable deduplication and generation contract.

## Opt-in configuration

Keep configuration and credentials outside the checkout/build context. Existing
deployments with no `CURSUS_HANDOFF_CONFIG_FILE` have no destinations or sender
loop. To enable later, use `compose.handoff.yaml` alongside the existing stateful
Compose files, with `CURSUS_HANDOFF_DIRECTORY` pointing to an existing external
directory. `config.json` contains:

```json
{
  "destinations": [{
    "id": "warehouse",
    "tenantId": "<deployment-tenant-id>",
    "label": "Warehouse",
    "protocol": "cursus.handoff.v1",
    "url": "https://receiver.example/instructions",
    "tokenFile": "/handoff/receiver-token"
  }]
}
```

The directory mounts read-only with fail-fast host-path validation. Protect its
host permissions and ensure UID 10001 can read the mounted files. Token rotation
requires recreating the application with the new secret; secrets are never
returned by the API. URLs may not contain credentials, query strings or fragments.
Do not use redirects to attach authentication. HTTP is reserved for explicitly
enabled loopback/private acceptance fixtures (`CURSUS_HANDOFF_TEST_HTTP=1`);
leave that flag unset in production.

Schema 5 adds intent/head/attempt tables and delayed job availability. Images
declare compatibility through schema 5; older images must not run new handoff
jobs. Back up PostgreSQL before an explicitly approved rollout. No destructive
down-migration or production activation is part of this implementation task.

## Tests

`npm --prefix server run test:ci` includes contract/failure validation.
`npm --prefix server run test:stateful` with the documented disposable PostgreSQL
environment exercises two APIs, real local HTTP delivery, crash-after-acceptance,
takeover, immutable bytes, receipt-only stale recovery and late-lease fencing.
Production-image Playwright acceptance adds Admin dispatch/cancellation and
Planner/Reviewer UI and API denials against a private test receiver with durable
PostgreSQL deduplication. No production connector, private dataset or real email
is used by these tests.
