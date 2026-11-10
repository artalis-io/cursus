# Changes review and exact instruction Undo

The existing Changes dialog separates saved manual decisions from scenario
instructions applied by the next Replan. Saved manual decisions already affect
the viewed plan and its KPIs; their history remains in manual planning. Undo in
Changes removes one instruction, without recomputing or overwriting a result.

Rows show saved-plan values alongside the requested vehicle, capacity or route
settings. Missing settings are labelled “Not recorded in this plan”; actual trip
counts and arrival times are never treated as configured limits. Delivery IDs
are shown alongside order references. Customer labels and saved assignments
are resolved only when the delivery identity is unambiguous in the matching
dataset. Repeated display references remain separate deliveries.

“Leave scenario” opens the day plan. It does not delete the scenario or undo its
saved results. They remain available in the Library. Removing a vehicle exclusion
removes only that instruction; saved manual decisions can still exclude the
vehicle. Undo cannot reconstruct pins or sequences removed by the exclusion.

## Authoritative command

`POST /api/scenarios/:id/undo-instruction` requires `scenario.edit`, authenticated
tenant scope, the existing CSRF protections and `If-Match: "<displayed revision>"`.
The body contains `instruction` (the complete displayed forward instruction) and
`datasetSha256` when it uses stable delivery IDs. Only removeVehicle, pin, forbid,
setVehicleConstraint and setSequence can be undone here. The server derives the
inverse; callers cannot supply arbitrary replacement edits.

The PostgreSQL transaction acquires the existing input-day advisory lock and
scenario row lock, then checks the revision, supersession, exact instruction and
stable delivery dataset binding. A changed, missing or duplicated instruction
fails closed. The legacy single-writer store performs the same checks and a
synchronous write. Immutable base scenarios cannot be undone. Successful Undo
increments the scenario revision once; saved plans, manual histories, result
KPIs and approval audit records are not rewritten. Existing approvals become
stale through the usual revision comparison.

The browser captures the clicked revision and instruction rather than rebasing
onto its general edit queue's latest revision. It disables mutations until the
response arrives, retains rows on failure and does not automatically replay a
conflict. Reload instructions reads the same scenario while preserving the
viewed plan; late responses cannot replace a navigated workspace. Reviewer can
inspect and reload but cannot Undo or Replan, including through the API.

No schema migration, solver change, customer dataset change or production
operation is part of this feature. Keep frontend and backend image versions
aligned; an older backend lacks this new command.

## Regression coverage

- All five inverse operations, stable duplicate references, changed/missing rows,
  duplicate stored rows, dataset mismatch and immutable bases.
- Two PostgreSQL API instances racing the same command and a peer edit, retry
  after success, Reviewer denial, and unchanged immutable result bytes/KPIs.
- Docker-hosted Playwright: exact duplicate-delivery Undo, pending request guards,
  stale request rejection and explicit reload, all instruction types, saved KPI
  preservation, Reviewer API/UI enforcement and Hungarian narrow layout.
