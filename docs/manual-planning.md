# Manual planning

Status: agreed design; implementation must not activate production automatically.

## Product contract

Extend the existing fleet panel, inspector, map, timeline, Changes panel and
KPI bar. Do not introduce a separate planning workspace or original-plan feature.
Group vehicles as Assigned (has work), Available (included, no work), and Excluded.
Keep searchable unassigned orders and bulk selection in the existing fleet panel.

Inspector actions: Assign to vehicle, Move to vehicle, Return to unassigned,
and Let optimizer decide. Assignment selects vehicle, trip and insertion position;
append is the default and new trips are explicit. Show predicted effects before
Apply. Drag-and-drop uses exactly the same command as keyboard/button controls.
Use existing components, spacing, badges, EN/HU translations and responsive layout.

The operator confirmed both defaults:

- Infeasible arrangements may be saved as clearly invalid Drafts. Explicit
  violations remain visible and approval is blocked. No implicit exemptions.
- Manual assignments AND manual deassignments persist through Replan until
  explicitly released to the optimizer.

## Semantics

Apply recomputes the selected arrangement without optimization. Replan invokes
the existing native Surge population-based workflow around retained decisions.
A retained assignment fixes the vehicle, not visiting order unless explicitly
sequenced. A retained deassignment remains unassigned, with a manual reason rather
than an invented solver reason. Let optimizer decide releases that decision;
it does not immediately move the order. Locked routes require explicit unlock.
Excluding a working vehicle requires confirmation, moves its work to unassigned,
and never deletes orders. Restoring makes a vehicle available without resurrecting
old assignments. Undo publishes a new revision, preserving history.

Resolve pending scenario edits before entering manual Apply. Never combine a
new scenario with totals or assignments from a stale plan. Every accepted batch
publishes an immutable Draft with parent plan and matching scenario revision;
saved/approved plans are never mutated in place. Manual updates supersede previous
approval through existing freshness rules. Export labels and approval gates remain
authoritative on the server.

## Identity and provenance

Use dataset-scoped request/task identities, not order display numbers (which can
repeat). Reject unknown identities, duplicate assignments, cross-day or cross-
dataset operations and ambiguous legacy identities. Never guess which duplicate
order number was intended. Historical plans without evidence remain explicitly
historical/imported rather than retroactively attributed to a solver.

Track initial source (optimizer/import/manual), current decision ownership
(optimizer/manual), actor, server timestamp, before/after vehicle/trip/position,
operation ID, parent plan, scenario revision and dataset identity. Keep immutable
assignment events separately from current retained decisions. Optimizing sequence
around a manual vehicle choice does not erase its manual provenance. Show a small
inspector badge and detailed history in Changes/audit; include provenance in
exports. Distinguish who assigned work from who calculated its schedule.

## Evaluation and accurate KPIs

The browser never calculates authoritative totals. Use pinned dataset matrix,
vehicle parameters, tariff identity and approved policy exceptions on the server.
Recompute source/destination vehicles and dependent later trips, including depot
returns, reload, waits, service and departure times. Preserve unchanged routes.
An empty trip is removed; an empty vehicle ceases contributing used-vehicle/fixed
cost totals. Per-vehicle fixed cost is charged once; per-trip pricing follows the
existing tariff. Cost source/currency remain visible; unavailable values are not
represented as zero. Store calculation/version identity with the plan.

Validate GVW, tail-lift, load progression/capacity, time windows, shifts, trip and
distance/duration limits, route locks and approved exceptions. Publish fresh manual
validation evidence, never reuse the parent's solver certificate. Invalid Drafts
can be inspected/exported as Draft but cannot be approved. Missing matrix cells,
unknown fleet metadata or unavailable validation must be explicit failures/unknown
evidence, never zero-distance legs or a fabricated valid result. Geometry loading
is separate from numeric evaluation; routing failures remain visible.

Coverage partitions scoped request identities exactly once into assigned or
unassigned. KPIs, map, timeline, inspector, week view and exports use the same
accepted plan snapshot. Pending/failed previews never combine new stops with old
totals. Reduced service is not labelled savings.

## API, security and concurrency

Introduce a bounded atomic manual-edit batch for assign/move/deassign/release and
sequence changes, with expected scenario revision, base plan identity and a unique
operation/idempotency key. Reuse tenant-scoped storage and existing scenario row
locking. Compute outside long transactions, then lock/recheck revision and commit
scenario decisions, plan and audit together. Same-key same-payload retries return
the existing result; same-key different-payload conflicts. Concurrent manual edits
or a stale solver completion cannot overwrite a newer authoritative snapshot.

Admin/Planner may edit under granular server permissions; Reviewer cannot. Existing
View-as restrictions apply at the API, not just buttons. Cross-tenant references
return no data. Approval/export races retain existing lock and freshness checks.
No schema/table changes without explicit migration and compatibility review.
Legacy mode must either implement equivalent semantics or reject unsupported
manual publication explicitly; never silently stage a pin and claim success.

## Acceptance and regression plan

1. Pure unit tests: identity conservation, duplicate display numbers, sequential
   edits, deassign/release persistence, empty trips/vehicles, deterministic preview,
   dependent-trip timing, fixed/per-trip tariff and missing matrix behavior.
2. Validator tests: every hard constraint, approved exceptions, unknown metadata,
   locked routes and invalid-Draft approval rejection.
3. API tests: bounded input, role matrix/View-as, tenant/day/dataset isolation,
   optimistic concurrency, retry idempotency and atomic failure.
4. Two independent instances: competing manual moves, edit versus native solver
   completion, approval/export races and cross-replica retrieval after publication.
5. Playwright against actual Docker production image/backend: buttons, keyboard,
   drag/drop and bulk assignment; unassignment/release; exclude/restore; undo;
   reload persistence; provenance; map/timeline/KPI/export agreement; invalid-draft
   feedback; EN/HU, narrow layout, Reviewer and View-as. Delayed/failed/out-of-order
   responses must not restore stale UI or submit duplicate operations.
6. Deterministic public fixture has independently hand-calculated expected values,
   not just UI-versus-API equality. Optional private Gyermelyi/native regression
   runs outside Git. No private fixtures, production test emails or writes.

## Implementation sequence

1. Identity/command/provenance contracts and pure invariant tests.
2. Full-plan deterministic evaluator/validator and KPI regression fixtures.
3. Durable fenced publication, retained decisions and solver integration.
4. Minimal existing-workspace UI, translations and accessible controls.
5. Two-instance/native and real-image Playwright suites; compatibility review.

Do not expose incomplete manual controls or deploy this feature before all five
steps pass. Production activation remains separately authorized.

## Implementation progress

The feature branch starts with a pure command core in `server/src/plan/manual.ts`:
dataset-scoped numeric request identities, exact coverage checks, immutable batch
application, retained assignment/deassignment decisions, explicit release, route
lock/exclusion checks and actor-stamped before/after history. Tests run under the
existing server CI pretest gate. The core deliberately provides no feasibility
certificate, HTTP endpoint or automatic production behavior.

Still required before exposing the feature: dataset/plan identity adapter,
full-plan evaluation and constraint validation, transactional/idempotent API
publication, solver integration, UI and Docker/Playwright acceptance. The pure
core rejects a previously applied operation ID; the future publisher must resolve
same-payload retries to the stored result under its transaction rather than
calling the core twice. Its inputs are internal typed snapshots, not raw HTTP.

### Executable coverage for the command core

Run `cd server && npm run test:manual:coverage`. This compiles TypeScript and
uses Node's built-in test coverage on the actual JavaScript module; no additional
coverage dependency or private dataset is required. CI runs the same command.
The expanded suite covers every command-core line, function and branch, plus a
500-operation seeded reference-model test for request conservation, retained
decisions, attribution and immutable snapshots. Boundary tests cover maximum
batch length, malformed identifiers/timestamps, operation reuse, locks, exclusion,
empty trips, multiple trips, zero IDs and rollback on partial failure.

These are command-core tests, not feasibility, database concurrency or browser
coverage. Independent pure branches are explicitly tested only for isolation;
they do not prove the future transactional publisher. API/two-instance and
Playwright cases in the acceptance plan remain required after those production
paths exist. No placeholder/skipped browser tests are counted as completed work.

### Evaluator increment

`server/src/plan/manual-evaluate.ts` evaluates internal delivery-only layouts by
stable request IDs, recalculates all trips with explicit departure anchors and
server-supplied reload durations, and returns fresh manual validation plus
coverage/distance/cost totals. Reuses the existing tariff helpers; reconciles trip
rounding to vehicle totals. Deterministic fixtures assert independent numeric
expectations, deassign/move effects, access/capacity/time/shift/limit failures,
missing data and duplicate display numbers. Coverage command includes this module.

This is not wired to production or the approval workflow. The parent-plan adapter
must first validate locked sequences and native precedences; the evaluator refuses
those models for now rather than certifying them. It also refuses non-delivery,
non-two-dimensional or non-default-depot models. Effective approved exceptions,
dataset/tariff identities and fleet metadata must come from a trusted adapter,
not HTTP request bodies. API publication, solver retained decisions and UI remain
unfinished. Full-plan mapping/export and cross-instance tests are still required.

### Dataset adapter and atomic publication increment

`manual-adapter.ts` binds immutable parent plans to the exact day, dataset and
effective policy. New solver mappings persist request IDs and dataset identity;
historical unique labels can be resolved, but ambiguous labels/access enrichment
fail closed. Trusted fleet metadata is matched exactly. Reload handling must be
explicitly configured, never inferred from gaps in old schedules. Locked routes
and scenario sequences are compared against the parent; native precedence is
checked against the recalculated schedule. Materialization emits the existing
Plan contract, fresh constraints, stable IDs, manual history and coherent KPIs.

`admittedManualDatasetLoader` uses tenant-scoped admitted records and verified
object reads, requiring exactly one matching dataset checksum/day. No first-row
fallback, private fixtures or new storage format is introduced. Fleet/tariff/reload
snapshots remain trusted server configuration, not HTTP inputs.

`POST /api/scenarios/:id/manual-plan` is classified as `scenario.edit` and requires
an explicitly installed server loader; it returns 503 by default. It requires
quoted If-Match intent, exact parent plan, dataset checksum and bounded commands.
Initial publication requires an editable copy scenario with a matching parent
plan; automatic base-scenario forking is not implemented yet. New-trip departure
anchors come from shift start and prior-trip/reload propagation, not client times.

Evaluation occurs outside the transaction. A short PostgreSQL transaction locks
the operation and scenario, rechecks revision and immutable parent, then commits
scenario decisions, new Draft plan and audit receipt together. Same actor/key/
payload retries return the existing plan even after revision advances; conflicting
reuse fails. Audit receipts reuse the existing ledger, without schema changes.
Old solver completion cannot publish over a newer manually published revision.

Executed isolated two-API/PostgreSQL/S3 tests cover concurrent identical retries,
competing moves, stale revisions, edit-during-evaluation, stale solver publication,
cross-tenant IDs, CSRF, Reviewer/View-as denial, failure at the final audit insert,
cross-instance retrieval, valid manual review and infeasible-draft approval refusal.
Dataset tests exercise verified immutable object reads and ambiguous source refusal.

Still intentionally unfinished: retained-decision native solver integration, UI
controls and real-image manual-workflow Playwright tests. Solve submission on a
manually published scenario is blocked until that integration exists, rather than
silently releasing manual decisions. No production opt-in, migration or deployment
has occurred. This increment is not a release-ready manual-planning feature.
