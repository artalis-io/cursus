# Dispatch readiness review

The expandable **Dispatch readiness** panel above the map is available to
Admin, Planner and Reviewer alike. It is entirely read-only: no new API,
permissions, schema, native solver flags or production role assignments.

It summarizes the displayed committed plan, not optimistic route previews:

- Coverage uses authoritative task counts and Surge's explicit unassigned list.
  Repeated order numbers are not deduplicated to calculate served counts.
  Fleet/request-based explanations are explicitly **inferred**, not reasons
  emitted by Surge. The native result currently provides request IDs only.
- GVW, tail-lift, payload/pallet capacity and time windows combine existing
  backend validation with mapped stop/trip evidence. Unknown GVW, missing
  evidence and an invalid native validation never become a green pass.
  Early arrival followed by waiting until opening is legal. Existing numeric
  tolerances are retained. Other hard backend violations also block readiness.
- Locked routes compare the exact vehicle and flattened stop sequence against
  the loaded scenario, but only if the plan belongs to that same scenario and
  revision. Stale locks are unverified, not approved against obsolete data.
- Approved exceptions show the immutable plan's recorded order, waiver and
  justification. They require review and never erase actual violations.
- Freshness requires matching scenario identity **and** revision. Queued edits
  and pending/running optimization immediately invalidate the current signal.
  This concerns the **loaded** scenario, not a guarantee that no other browser
  has changed authoritative state since the last fetch. Refresh before dispatch.
- Comparison identifies the exact configured day baseline. That baseline may
  be a selected optimized plan, not the original handwritten plan. Cross-day,
  different/missing order scope and different cost currency/source suppress
  misleading deltas. Costs remain estimates; source class is not a cryptographic
  tariff-version guarantee. Lower cost is never described as efficiency savings
  if baseline service was dropped or exchanged, even at equal served counts.

**Snapshot checks passed** is not a dispatch approval or a new native feasibility
run. **Action required** covers stale/pending work, unassigned orders,
inconsistent coverage and hard violations. **Review required** covers missing
evidence, advisories, exceptions and an empty workload. The panel does not
certify every possible constraint, geographic restriction or latest server state.
The existing Issues dialog remains the detailed violation/location inspector.

## Regression coverage

`web/acceptance/readiness.spec.ts` checks pure snapshot assessment: boundary GVW,
early waiting, hard/unknown violations, missing evidence, scenario identity and
revision, pending work, exact route locks, exceptions, authoritative task counts,
duplicate references, lost/exchanged service and incompatible comparisons.

`web/acceptance/runtime.spec.ts` exercises the real two-instance stateful app,
including Reviewer access, English/Hungarian rendering, narrow layouts, and a
held real edit request proving that readiness changes before persistence responds.
Run the complete production-image suite using `python3 deploy/acceptance.py`;
the pure tests alone do not certify a release. No test requires private fixtures
or production credentials. See [release acceptance](release-acceptance.md).
