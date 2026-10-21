# Revision-bound review and collaborative editing

This is a decision-cockpit review record, not dispatch/execution tracking. No
original or handwritten plan is required or introduced. Existing comparisons
continue to use saved plans and scenario revisions.

## Permissions

| Role | Read review history | Mark reviewed | Approve |
| --- | --- | --- | --- |
| Reviewer | Yes | No | No |
| Planner | Yes | Yes | No |
| Admin | Yes | Yes | Yes |

Admin View as remains server-enforced. Review and approval do not change tenant
membership or bypass constraints. An Admin may review and approve the same plan:
this is not a four-eyes guarantee.

## Concurrent edits

Scenario edit, batch edit, rename, delete and optimization submission require
`If-Match: "<loaded revision>"`. Missing preconditions return 428; malformed
headers return 400; stale intent returns 409 without applying the operation.
Do not fetch the latest revision and automatically replay a rejected operation.

PostgreSQL checks the supplied revision at the authoritative write boundary.
Scenario edits/forks are atomic; solve admission checks its snapshot under a
scenario lock. A solve admitted before a later edit may finish, but its old
revision cannot be approved as current. Immutable base scenarios may be forked
independently by multiple users; those are different scenarios, not overwrites.

The browser polls the loaded scenario every five seconds and on focus/visibility
changes. A stale or unverifiable workspace blocks editing, evaluation and solving
and offers explicit reload confirmation. Queued intents are invalidated on a
conflict, never silently replayed. The server is authoritative between polls.
Scenario rename conservatively increments the revision too.

## Review lifecycle

`draft -> reviewed -> approved`; later scenario edits make existing review and
approval records `superseded`. Re-optimize and review the new immutable plan.
Each plan has its own history; approving one does not select it for dispatch or
revoke another plan's approval.

GET `/api/plans/:id/workflow` is tenant-scoped. POST `.../review` and `.../approve`
require the workflow `version`, scenario `revision`, and explicit
`acknowledgeExceptions: true`. The authenticated session supplies the actor;
client-supplied identities do not establish authority. Approval requires review.
Repeated or concurrent transitions fail with 409 rather than append duplicates.

Transitions lock the scenario row, sharing the edit/delete serialization boundary.
They append to the existing PostgreSQL audit ledger with actor, timestamp, exact
plan SHA-256, scenario/revision, monotonically increasing workflow version and
exception acknowledgement. No schema migration is required. Status is derived
from current scenario revision and immutable plan bytes, so old records remain
available rather than being overwritten. Retain these audit events with backups;
they are authoritative review history, not disposable request logs.

The gate fails closed on incomplete coverage, missing dataset identity, stale
revision, missing/failed validation, hard violations, mapped GVW/tail-lift,
capacity/time-window failures and mismatched locked routes. It uses stored solver
and mapped evidence; it is not a new native feasibility certificate. Approved
policy exceptions remain visible in Dispatch readiness and must be acknowledged.
Unknown evidence is not a pass. Arrival before opening with service waiting for
opening is legal.

The legacy local runtime supports revision preconditions but not persistent plan
approval, and does not advertise those capabilities. Shared approval requires
PostgreSQL. Local unauthenticated stateful development records a null actor with
`actorMode: local`; production continues to require authenticated sessions.

## Compatibility and release

This changes write preconditions: older browser clients must reload the new SPA.
Keep API and frontend image revisions aligned. No native solver parameters,
Freshness guarantees require all writable replicas to run this implementation;
an old backend does not enforce the new precondition contract during a mixed-version window.
datasets, production infrastructure or original-plan functionality are changed.
Do not treat application rollback as permission to overwrite live PostgreSQL.

Regression coverage includes header validation, role permissions, constraint
evidence, tenant isolation, two-connection conflicts and review serialization,
cross-replica browser checks and native solver workflows. The optional private
Gyermelyi conversion suite remains a separate explicitly configured test.
