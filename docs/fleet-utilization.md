# Saved-plan fleet utilization

The Vehicles KPI opens a read-only breakdown, following the existing Cost KPI
interaction. It adds no permanent dashboard row. Admin, Planner, Reviewer and
Admin View as can inspect the same tenant-authorized saved plan. Existing vehicle
and trip inspector links retain their existing permission rules. Opening or
closing the panel does not save changes, submit work, load a private matrix or
make a new API request.

## What the numbers mean

- The Used summary is the exact saved KPI. Vehicle/trip detail counts are checked
  against it; inconsistencies are shown rather than silently correcting the KPI.
- Delivery-only trip peak load is the sum of its nonnegative delivery demands,
  checked against the recorded trip load. Vehicle peak is the maximum across
  trips, checked against the recorded vehicle peak. Reloads reset cargo: loads
  are never summed across trips to calculate vehicle utilization.
- Percentages and headroom use recorded payload and scalar pallet capacities.
  Missing, zero, negative or non-finite capacities are unknown, not 0% utilized.
  Fractional pallet demand is retained. Percentages above 100% and negative
  headroom are not clamped or hidden. Unsupported pickup/mixed-load semantics
  and inconsistent cargo totals withhold peak claims.
- Stop service uses departure minus service start, not rounded service minutes.
  Waiting uses service start minus arrival. Driving includes the return-to-depot
  leg. The schedule must reconcile with recorded leg durations and stop waiting
  within one second, and trips must not overlap.
- Vehicle elapsed time runs from first departure to final return. Between-trip
  time is the sum of all intervening gaps, not an assertion that all of it was
  required loading. Required reload time is displayed separately when recorded.
- Shift headroom is the recorded shift end minus final return; duration headroom
  is the configured route-duration limit minus elapsed route time. Missing limits
  remain unknown. This is not a statutory driving-hours/rest compliance check.
- Recorded constraint flags reuse the existing localized violation explanations.
  They are not inferred explanations of why the optimizer selected a vehicle.

Unused available, excluded and unavailable counts require a complete saved fleet
inventory. A policy-unavailable vehicle is not presented as assignable; the panel
does not invent a reason such as unverified equipment when none was recorded.
Availability describes planning-time policy, not a live operational roster.

Spare weight, pallet capacity or time is not proof that an order can be inserted,
a truck removed, or a physical load stacked safely. Existing assignment preview,
Replan, constraints, approved exceptions and approval checks remain authoritative.
This feature changes neither native solver parameters nor optimization behavior.

## Immutable fleet evidence

New plans may contain additive `provenance.fleet` version 1. Its plan ID,
scenario/revision and input checksum bind the facts to the saved result. A compact
whitelist records vehicle identity, availability, capacities, shift bounds,
route-duration/distance/trip limits and required reload time. No credentials,
customer files, unused tariff rows or travel matrix enter the snapshot.

Native conversion captures the effective fleet before exclusion, preserving the
actual overridden capacities/limits of eligible vehicles after scenario edits.
Excluded unused rows retain their source declarations; the UI does not claim
these are the settings a future re-enabled vehicle would use. Manual saves
capture the full evaluated fleet and effective exclusions. Input replacement
rebinds its newly materialized facts after final plan/scenario IDs are assigned,
including its new base plan. Existing fenced publication protects the entire
result, including this evidence.

Mapper callers that supply only the solved eligible request record explicitly
partial inventory. Historical plans are not rewritten: used-vehicle capacities,
loads and schedules can still be inspected, but absent full inventory and shift
limits cannot be reconstructed from current settings. Borrowed, contradictory or
malformed fleet snapshots are rejected for inventory and limit claims. A changed
scenario displays a warning; pending edits and previews do not replace saved
figures.

The pure browser-safe projection is `server/src/fleet-utilization.ts`, shared
with domain/integration tests. There is no new endpoint, permission, SQL migration,
database table or external dependency. The existing tenant-bound plan API is the
read boundary. Plan approval, export identity, worker leases and fencing are
unchanged; old approval evidence is never transferred to a new result.

## Verification

Domain tests use independently specified loads and schedules for multi-trip
reloads, depot returns, fractional pallets, whole-second timing, missing facts,
overloads, empty schedules, inconsistent peaks, mixed pickup/delivery, extreme
ratios, bad snapshot identities, stale facts, KPI disagreement and input identity
rebinding. Existing manual and input-update tests assert snapshot materialization.
Two independent APIs exercise JSONB retrieval, Reviewer access, tenant denial,
read-only behavior and preservation of old facts after scenario changes.

Production-image Playwright tests cover keyboard/focus behavior, all three roles,
EN/HU narrow layouts, exact saved KPIs, manual saves, peer retrieval, native vehicle
exclusion, inspector navigation and rejected historical evidence. Full acceptance
also covers the existing planning, approvals, exports and physical-loading paths.
Executed test results and optional skips belong in release evidence; this document
is not a claim that unexecuted private Gyermelyi tests passed or an authorization
to deploy.
