# Change profiles while preserving manual planning

Use **Planning profiles → Preserve current planning with new profiles** to apply approved fleet or site revisions to an existing plan without rebuilding its assignments from scratch. This creates a separate Draft scenario and plan. The source scenario, plan, selection and approval remain unchanged.

## Operator flow

1. Open the current selected plan. Finish pending edits or solves first.
2. Select exact approved revisions for the same admitted dataset. Previously pinned profile kinds require an approved replacement; this flow cannot drop a governed profile to bypass its limits. Approving a profile alone still does not change any scenario.
3. Expand the reviewed-change section, enter a reason and preview.
4. Review setting differences, preserved decisions, route/lock conflicts and recalculated totals. Saved current totals are distinguished from recalculation; a tariff change is not an efficiency saving. Costs retain their own currency, with no implicit currency conversion.
5. Resolve conflicts explicitly in the new draft. Clear an override that exceeds the new approved limits; release an affected retained assignment; or release a route's order/lock. Recalculate the preview after any choice changes. Nothing is released automatically. Releasing an assignment does not move or unassign its delivery: it frees the solver to reconsider it on Replan.
6. If remaining unlocked placements are infeasible, an explicit acknowledgement permits saving an invalid Draft. Such a draft cannot be approved. Hard physical loading always needs a fresh native certificate after changing settings.
7. Confirm and create the new draft. Its assignments, trip IDs, stop order, original attribution and history are retained except for the explicit resolutions. Replan and review/approve separately as appropriate.

Admin and Planner may preview and create drafts; Reviewer and Admin View as Reviewer remain read-only. Only Admin can approve profile revisions. No new role or infrastructure is introduced.

An accepted, pending or uncertain downstream handoff blocks this operation until the existing cancellation/reconciliation process completes. Creating a draft never sends a handoff, optimizes, emails, rewrites a dataset or changes an external system.

## Identity, concurrency and recovery

The source must be a current, non-archived plan selected in its exact scenario revision. Profiles and immutable input remain tenant- and checksum-bound. Legacy ambiguous delivery restrictions, missing source facts or changed fleet identity fail closed. Recorded manual settings are used to verify the source even if current external fleet settings have drifted; target settings are loaded independently.

Preview recalculates the complete fixed layout with the same manual evaluator used by editing. It runs outside a database transaction, using the immutable matrix and approved target settings. An incompatible scenario override blocks numerical evaluation rather than displaying totals calculated with silently discarded overrides. Locked-route and retained-decision conflicts block creation until explicitly resolved. Ordinary remaining invalidity is displayed and requires acknowledgement; it never becomes approval.

Application recomputes the preview and verifies its digest. A short transaction then rechecks current membership, source selection/revision/body, immutable parent bytes, admitted manifest, approved profile bytes and downstream commitments. Source scenario locks serialize with edits, native completion, selection, approval and handoff publication. No database transaction spans object reads or route evaluation.

A stable operation ID and actor-bound audit receipt make a lost-response retry return the original immutable result. Reusing the operation ID with different intent fails. Different operators can deliberately create separate alternatives from one unchanged source; neither replaces it. A changed source or stale preview fails instead of applying to another revision.

The new scenario and plan record the source IDs/revision, exact profile references, reason, actor, resolutions and timestamp. Native replanning retains this lineage and the new manual-policy snapshot. Undo works within the new settings context; it cannot cross back into the source profile context. Old immutable plans and approvals remain inspectable. Application rollback must retain support for already used profile semantics; restoring an old database over new writes is not an application rollback.

## Interface and validation

- `POST /api/scenarios/:id/profile-change-preview`: reviewed intent, with quoted `If-Match` revision.
- `POST /api/scenarios/:id/profile-change-apply`: `{intent, previewSha256, confirm:true}`, with the same revision.
- Both responses are private and uncached. Evaluation is bounded to one reviewed-profile operation per replica; contention returns 429 with Retry-After. Missing trusted dataset/settings support returns 503.
- No schema migration. Additive optional lineage is stored in existing JSON snapshots and audit events. Both replicas must support the reviewed-change flow before operators use it. Do not roll back to a version that cannot enforce the selected profile semantics; retain newly created scenarios and production writes.

Regression coverage includes exact KPI/cost calculations, unavailable vehicles, operating limits and override precedence, locks and explicit releases, immutable history, invalid-draft/physical-loading gates, tenant isolation, role revocation and View as, idempotent two-replica retries, stale selections, approval and handoff boundaries, native Surge replan, and EN/HU Playwright workflows. Use public fixtures and distinguish executed tests from optional private-data tests. This feature does not authorize production deployment.
