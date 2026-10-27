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

At this increment UI controls and real-image manual-workflow Playwright tests
remain unfinished. No production opt-in, migration or deployment has occurred.
This is not a release-ready manual-planning feature.

### Retained-decision native integration

The converted/admitted dataset executor now applies stable-ID retained decisions
after scenario sequences and access limits. Manually unassigned requests forbid
every available vehicle; removed pinned vehicles also yield explicit forbids,
never an empty native allowlist. Dataset allowlists and safety forbids remain
binding. New explicit decisions supersede old label-based scenario pins, including
on release. Seeds/frozen flags cannot restore contradictory assignments, and empty
filtered seeds are removed because the native parser rejects empty routes.

Native results are independently checked for exact request partition, task/vehicle
identity and retained restrictions before mapping. Optimized plans contain a fresh
`assignments` snapshot with preserved origins/manual history and the current
dataset identity, not a copied manual evaluator certificate. The API adapter can
subsequently edit this optimized snapshot. PostgreSQL completion rechecks retained
decisions, request inventory, history, layout and coverage KPIs under the scenario
lock and live lease fence. It advances the derived current-plan pointer without
changing the scenario's planning revision. A stale lease or old scenario revision
cannot publish over manual work.

Replan submission is available for manually published scenarios only in the
explicitly opted-in manual runtime with complete state. Production's default
configuration still does not install the loader, expose manual controls or enable
manual planning. Manual source selection must match exactly one admitted dataset
checksum/day; policy and retained dataset identities cannot disagree.

Executed tests use the real native population solver on a small public fixture:
retained assignment/deassignment, explicit release, GVW/tail-lift/capacity safety,
two independent API/store instances, verified S3-compatible objects, durable solve
jobs, native completion after lease takeover and forged-provenance rejection at
the authoritative transaction. These are not country-scale Gyermelyi runs or a
claim of country-scale or production deployment validation. The subsequent
workspace increment adds real-image browser acceptance, described below.

Local verification was repeated against a freshly built solver from Cursus's
unchanged vendored OTTO pin `367061d015f6776f7ea27fb01726c1a14cb4614c`, not just a
binary from a newer adjacent checkout. CI's stateful job now builds that pinned
solver through OTTO's existing Makefiles and runs both the native constraint
suite and the public two-instance manual/replan workflow. Optional private
Gyermelyi conversion tests remain separate and were not run for this increment.

### Workspace implementation

An explicit **Manual planning** toggle in the existing fleet panel preserves the
legacy staged-replan workflow until opted in. Manual drafts always use the manual
controls. The fleet groups Assigned/Available/Excluded use server-returned fleet
metadata, including unused vehicles. The inspector supports move/assign, return to
unassigned and release, with retained-decision badges and actor/time history.
Drag/drop and bulk assignment use the same dialog and API as keyboard controls.

The dialog calculates a server-side preview before enabling Apply. Any changed
parameters invalidate it; late responses after unmount/permission loss are ignored.
Save invalid draft remains explicit and does not bypass review/approval blockers.
Preview does not publish plans/scenarios/jobs. Apply forks a baseline atomically
without modifying it, or advances an existing copy with If-Match/idempotency guards.
Exclusion confirms affected orders, deassigns them atomically and retains those
decisions; restore does not resurrect assignments. Undo restores the previous
arrangement as a new audited draft rather than deleting history or saved plans.
Draft identifiers (not dataset bytes) are stored in a tenant-scoped browser
preference for reload recovery, with authoritative server reads on restoration.

Runtime opt-in requires `CURSUS_MANUAL_SETTINGS_FILE`, an external JSON file with
`tariff` (the existing Tariff contract) and `vehicles` entries containing `id`,
`ref`, `vehicleClass`, `isSubcontractor`, `tonnage`, `hasTailLift`, and `reloadSec`.
Mount it read-only; do not commit customer fleet or pricing information. Missing
configuration leaves the feature disabled. Invalid/stale/ambiguous dataset
evidence never produces an enabled control. Tariff and fleet snapshots are
recorded with manual decisions and reused by subsequent solves; tariff identities
are canonical across PostgreSQL JSON key reordering on separate replicas.

All UI strings have EN/HU translations. Production is unchanged: no settings,
Cloudflare resources, containers, database migrations or customer data are deployed
by this implementation. Real-image acceptance uses synthetic external settings
and dedicated temporary Compose projects, never production credentials.

The S3 protocol fixture uses a disposable project-scoped disk volume (removed by
`docker compose ... down -v`), not tmpfs: SeaweedFS can reserve gigabytes for tiny
objects, pinning RAM and starving unrelated local map services. Run standalone
integration and full-image acceptance stacks sequentially and tear each down;
neither test workflow stops the operator's local or production deployments.

Reload seconds are also snapshotted and passed via Surge's actual
`trip_reload_seconds` vehicle field. Explicit dataset reload times must match the
manual settings; mismatches fail closed. Native regression coverage forces two
capacity-limited trips and verifies the intervening dwell. Authoritative result
publication rejects a shorter reload gap instead of accepting inconsistent timing.

### Browser verification and release boundary

The local ARM64 production-image acceptance suite passed 61/61 tests with no
skips, retries or flaky results at source `58b7cd6`. It runs two independent
application instances against disposable PostgreSQL and S3-compatible storage,
using public synthetic inputs and the pinned native Surge executable. Manual
coverage includes Admin/Planner assignment, deassignment and release followed by
native Replan; Reviewer/API denial; invalid drafts; exclusion/restore; bulk and
drag/drop; Undo; reload recovery; Hungarian mobile controls; permission changes
during preview; and retry after a committed response is lost. Preview must not
publish state, and independent matrix/tariff calculations check accepted KPIs.

The command for certifying a newly built source/image pair is:

```bash
python3 deploy/acceptance.py --image YOUR_LOCAL_IMAGE --report /external/path/manual-acceptance.json
```

The report binds the tested image ID, source revision and native executable
checksums. Keep reports and browser artifacts outside the source tree. A passing
synthetic suite does not certify private Gyermelyi inputs, real map assets,
AMD64 execution or a production rollout. Manual planning remains opt-in; enabling
it for a customer requires validated fleet/tariff settings and separate rollout
approval. Plan JSON handoff includes assignment provenance; the legacy
scenario-configuration export is not a manual-workspace backup or round-trip
format.

Final application source `c7e2445` was built locally as ARM64 image
`sha256:c0e0c25649febc79a6e8127882c3a4fee5c569d32f97541164c3b0829a16e4f6`.
All nine manual browser cases passed on that image. Two attempts to finish its
entire suite were interrupted by host sleep (including a logged macOS thermal
sleep despite an idle-sleep assertion), so neither is a complete passing
certificate for this image. Their reports remain failed; do not substitute the
earlier 61/61 certificate for this source. Repeat the full acceptance command on
an awake, stable host before release. The server suite passed 167/167; focused
manual coverage passed 44/44 with 100% line/branch coverage for the command core
and 100% line coverage for the evaluator. No production rollout occurred.
