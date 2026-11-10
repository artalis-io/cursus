# Explainable saved-plan costs

Click the existing Cost KPI to inspect the estimate for the exact saved plan and
scenario revision. The same read-only dialog is available to Admin, Planner and
Reviewer, including Admin View as. It adds no permanent dashboard band. English,
Hungarian, keyboard navigation and narrow layouts use the existing UI conventions.

The dialog shows saved fixed, variable and total amounts, used-vehicle and trip
contributions, applicable effective rates, multiplier, tariff fingerprint and
pinned fleet-profile revision where recorded. It separates saved calculation
reconciliation from compatibility with current configured pricing. Pending edits,
preview amounts and newer scenario revisions never reprice the saved result.

## Existing calculation, unchanged

`server/src/cost.ts` remains the authority. This feature does not change tariff
selection, optimization, charges or allocation rules.

- **Per vehicle:** standing charge once per used vehicle, plus its rounded
  vehicle-distance charge. Only subcontracted vehicles receive the configured
  subcontractor multiplier in this model, matching the existing engine.
- **Per trip:** sum of trip bases and each trip's distance/extra-stop charges,
  using the applicable own-fleet or subcontractor multiplier. Included stops
  apply separately to each trip.
- Pricing distances use the existing nearest-0.1-km conversion. Fixed and variable
  components are rounded separately to whole currency units at vehicle level,
  including currencies other than HUF. The dialog explains this existing rule;
  it does not introduce fractional-currency billing or exchange-rate conversion.
- Existing trip estimates are reconciled to the authoritative vehicle total.
  The displayed allocation adjustment is the saved allocation minus the trip
  reference estimate. It is not another charge. Rounding and vehicle/trip distance
  bases can affect allocation; the dialog does not assert they are identical.

All displayed saved totals reconcile exactly when evidence is Verified. A
saved-plan comparison names its reference, shows raw differences and coverage,
and never labels reduced service as savings. Different currencies are displayed
separately without subtracting or converting them. Pricing/calculation verification
is not route feasibility, plan approval, an accepted carrier quotation or an invoice.

## Immutable evidence and historical compatibility

New native, manual and input-replacement plans record an additive
`provenance.costing` snapshot. It binds effective per-used-vehicle rates to the
plan ID, scenario/revision, input SHA-256, tariff fingerprint, model and currency.
It captures the effective rates selected at creation, rather than persisting
unused private rate-card rows or arbitrary configuration fields.

This matters because the existing substring class-rate lookup can depend on map
iteration order. JSONB may reorder object keys, while the existing canonical
fingerprint is insensitive to that order. Stored effective rates preserve the
actual calculation. Current pricing compatibility also checks effective rates,
so a changed precedence cannot silently appear compatible solely because the
canonical fingerprint still matches. This feature does not change the lookup or
fingerprint used by existing planning/approval logic.

Old plans remain unchanged. Their formulas are available only if an approved
historical profile or current scoped settings match the recorded tariff checksum,
class selection is unambiguous, and the calculation reconciles with every saved
vehicle and trip amount. Matching-looking totals alone are insufficient. Otherwise
stored amounts remain visible with incomplete evidence and no inferred formulas.
Contradictory, borrowed, unsupported or malformed snapshots withhold all formulas;
no corrected estimate is substituted or persisted.

## API and concurrency

`GET /api/plans/:id/cost-breakdown` requires existing `workspace.read` access and
is tenant-bound with `Cache-Control: private, no-store`. It reads the immutable
plan, current scenario revision and relevant immutable profile/configuration
pricing. It does not load private matrices, call native executables, enqueue work,
create objects, send emails or write scenario/plan state. Legacy local mode uses
the same explanation function with its configured tariff.

The response contract is `server/src/cost-review-contract.ts`. The frontend checks
its binding to the viewed plan, saved amounts, tariff, vehicles and trips before
showing formulas. Closing, changing days/plans, refreshing or changing scenario
context aborts/invalidates older requests. Failed refreshes remove old formulas,
retain the viewed saved totals and offer Retry. Current-pricing status describes
the time of the check; Refresh evidence is an explicit read-only action.

No SQL migration or rewrite of saved plans/customer datasets is required. Existing
approval, export, manual-history, fencing and tenant guarantees remain authoritative.

## Verification

Coverage includes both pricing models, fractional rates, whole-unit EUR rounding,
multiple trips, fixed-cost non-duplication, both allocation directions, multipliers,
class precedence after JSONB, stale tariffs/scenarios, legacy/missing evidence,
borrowed/corrupt proof, two independent APIs, tenant/role boundaries, profile
resolution, input-replacement identity rebinding and immutable saved totals.

Production-image Playwright tests exercise the Cost KPI, manual plans, comparison
warnings, failure/retry, Reviewer EN/HU inspection, bounded layouts and late replies.
Executed results belong in the release evidence; optional private/native tests
must be distinguished from executed synthetic tests. Implementation does not
itself authorize production deployment.
