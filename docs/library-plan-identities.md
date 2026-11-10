# Finding and identifying saved plans

The plan and scenario libraries search within the selected planning day by scenario name or full plan reference. Search is case-insensitive and accent-insensitive. Clear the search to return to the complete day inventory.

Each result shows its plan reference, scenario/plan revisions, creation time, coverage and verified status. These labels describe separate facts:

- **Viewed** is the plan currently open in this browser.
- **Selected** is the scenario’s authoritative selected plan, including its manual-plan fallback.
- **Latest** is its most recently created result, with a deterministic plan-ID tie-break. It need not be selected or current.
- **Approval** comes from the existing tenant-scoped approval ledger and immutable plan hash. A superseded approval is never presented as Approved.
- **Freshness** compares the scenario revision and applicable planning/loading policy. Archived scenarios are explicit. Current does not certify feasibility or approval.

Opening a saved result does not select, adopt, approve or modify it. The scenario library offers separate actions for the selected plan and latest result when they differ. Existing comparison behavior is preserved.

## Consistency and unavailable verification

PostgreSQL catalogue responses read scenarios, plans, approval events and loading policy within one repeatable-read, read-only transaction. They do not lock rows for update, execute solvers or access object storage. The recorded timestamp describes that snapshot; it is not a promise that nobody has edited the scenario since. Refresh or open the plan to verify current state.

Responses are private and not cacheable by HTTP intermediaries. A failed refresh may retain the previous list for navigation, but its approval and freshness become Unknown and selected/latest claims are withheld. Missing, malformed or mismatched identity metadata also becomes Unknown. Legacy mode has no authoritative approval ledger and therefore reports approval/freshness as Unknown.

The existing scenario `latest` API field retains its compatibility semantics. New `latestResult` and `selectedResult` fields distinguish the actual newest result from the selected result. Plan summaries gain a versioned `identity` field. No schema migration is required.

## Regression coverage

- PostgreSQL integration: two independent API instances, tenant isolation, selected versus newest results, approval invalidation, archived scenarios, and a peer edit during a paused catalogue read.
- Playwright: native planning followed by distinct viewed/selected/latest badges, peer approval/edit, failed refresh, reopening without adoption, scenario navigation and Reviewer read-only behavior.
- Pure browser tests: accent-insensitive reference search and rejection of borrowed, malformed or contradictory status evidence.
- Existing library recovery tests retain coverage for scope changes, permissions, refresh failures and long scrollable histories.

This feature changes library discovery and metadata only. It does not change solver behavior, roles, plan selection, approval transitions or production deployment configuration.
