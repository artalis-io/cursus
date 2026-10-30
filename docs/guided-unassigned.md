# Resolving an unassigned delivery

Select an unassigned order, then **Assign to vehicle… → Find feasible
placements**. Admin and Planner can use this flow without toggling manual mode.
Reviewer can inspect the order and its existing history, but cannot search,
preview or apply assignments, including through the API or Admin View as Reviewer.

The assignment dialog shows the best found insertion per vehicle (up to five),
ranked by additional cost, then distance and vehicle finish time. It checks every
insertion position in existing trips and an appended new trip. Excluded,
unverified and locked vehicles are skipped. The current layout and each candidate
are recalculated with the same immutable matrix, tariff and pinned planning
settings; the reference values are displayed explicitly. Historical displayed
totals may have different rounding or settings and are not the comparison basis.
The estimates are changes, never a claim of savings from reduced service.

Selecting a placement only fills the existing vehicle/trip/position form. The
planner must **Calculate preview**, review the complete draft, and **Apply manual
change**. Publication revalidates the actual intent against current authoritative
state. Existing transaction fencing, operation idempotency, history attribution,
immutable plan retention, approval invalidation and Undo remain in force.

## Evidence and limits

The pinned Surge executable reports unassigned request IDs, not per-delivery
reasons. Fleet-based explanations are explicitly inferred. The new blockers are
evidence from rejected insertion drafts, not solver-confirmed explanations of
the original outcome. They may concern another stop or a later trip; the UI
states this and identifies the affected vehicle.

Every suggested placement validates the complete plan with the existing manual
evaluator: GVW, tail-lift, payload/pallet capacity, time windows, vehicle shifts,
reloads, maximum trips/distance/duration, assignment restrictions, route locks,
sequences and precedences. Previously approved exceptions are supplied by the
existing admitted-dataset/policy adapter. Searching cannot create or expand an
exception. Invalid drafts may still be edited through ordinary manual planning,
but are never offered as feasible suggestions or implicitly approved.

This is a bounded insertion search, not HGS or a feasibility proof. Each replica
allows one search at a time, returning HTTP 429 with Retry-After while busy.
Search stops between candidates at 750 evaluations or 1.5 seconds, yielding to
the event loop every eight evaluations. Partial results are clearly labeled.
No suggestion does not establish that an order is impossible to serve: changing
departure times, moving other orders, releasing locks or running HGS can reveal
other arrangements. New trips are appended, not inserted between existing trips.

## API and consistency

`POST /api/scenarios/:id/placements` requires `plan.evaluate`, same-origin access,
a quoted `If-Match` scenario revision, and exactly `parentPlanId`,
`datasetSha256`, `requestId` in its JSON body. The delivery must be unassigned in
the current tenant-authorized plan. Dataset, selected plan and revision must
match; a scenario change during evaluation discards the result with HTTP 409.
No database transaction is held during evaluation. Responses are private and
not cacheable. Search does not create jobs, plans or scenario revisions; normal
authorization audit entries may be recorded.

Regression coverage includes deterministic ranking and costs, independent
candidate reevaluation, hard restrictions, downstream trip timing, bounded
search, tenant/role isolation, two-API publication and concurrent edits, busy
handling, and Playwright assignment/preview/KPI/history and late-response role
demotion cases. Customer data is not included in fixtures.
