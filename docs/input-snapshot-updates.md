# Reviewed input snapshot updates

Update one planning date using an already admitted immutable snapshot. CSV/XLSX
conversion remains the existing Nexus/geocoding/Velo admission workflow. This
feature never edits input bytes, constructs matrices, sends handoffs or emails,
or treats a dataset-scoped native request ID/order number as a cross-export key.

1. Choose the replacement snapshot for the same planning date.
2. Review delivery correspondence. Unique references may suggest pairs; the
   operator confirms or corrects them. Duplicate references need explicit pairs.
3. Preview added, cancelled and changed deliveries, affected routes, retained
   decisions, locked-route conflicts, policy requirements and recalculated KPIs.
4. Explicitly release obsolete decisions/unlock affected routes with a reason.
   Approved target profiles must replace dataset-scoped source profiles. Only
   an Admin may explicitly reapprove unchanged-location access exceptions for
   the replacement snapshot; no new exception values can be supplied here.
5. Create an updated draft. Unchanged route arrangements and surviving manual
   decisions are retained. New deliveries start unassigned. Replan uses the
   existing durable HGS worker, respecting retained assignments and locks.

The source workspace advances its revision and becomes superseded in the same
transaction that creates the new draft. Immutable source datasets/plans and the
complete prior scenario snapshot remain in audit history. Source approvals can
no longer produce Approved exports. New drafts never inherit approval. Old
workers, previews and concurrent updates cannot overwrite the new revision.

Accepted, in-flight or ambiguous downstream handoffs block supersession until
their existing cancellation/reconciliation process completes. Route locks do
not establish physical execution state; external systems retain that authority.

The new planning cycle has a separate logical day and an exact binding to its
admitted dataset/day/checksum. All runtime reads and solves use that binding;
there is no latest-dataset fallback. Fleet identity changes fail closed rather
than guessing physical vehicles. Missing or ambiguous source evidence blocks
an update. Undo cannot cross a dataset boundary; source snapshots remain
available for explicit reviewed recovery. No automatic database/data rollback.

Admin and Planner may prepare/apply updates; Reviewer remains read-only.
Application requires a preview digest, exact source revision/selection, fresh
membership authorization, a stable operation ID and reviewed correspondence.
Replays return the original immutable result; changed intent and racing writes
fail closed. Expensive reads/evaluation happen outside database transactions.

## Operator flow and limits

In **Data**, upload, convert, validate and admit the revised input using the
existing workflow. Admission alone does not replace an active plan. Open the
current selected plan and choose **Update input snapshot** in the toolbar.
The dialog shows admitted alternatives for the same ISO date. A reason,
reviewed correspondence, preview and explicit supersession confirmation are
required before **Create updated draft**. New or cancelled deliveries are never
silently matched by position. Request IDs can change between exports; duplicate
business references deliberately have no suggested match.

Review the replacement profile contents before proposing/approving them. A
Planner can propose them; an Admin must approve them. A Planner cannot reapprove
existing access exceptions, including through Admin View as Planner. Exception
destinations and original source restrictions must remain verifiably unchanged.
Fleet inventory/configuration changes and changed exception destinations require
separate reconciliation; this dialog cannot manufacture an exemption.

All alternatives in the previous logical day become read-only together, with
their original scenario bodies retained in the audit event. Archived cycles stay
in the day selector and expose **Open updated inputs**. Weekly totals count only
active cycles. Snapshot lineage workspaces cannot be deleted through ordinary
scenario deletion; their immutable plans and input objects remain available.

Only plans with native delivery IDs and verified source data can be updated.
This first version requires a different native request checksum. A metadata-only
correction with identical request bytes is not offered as a replacement. It does
not infer loaded/departed work, revise accepted warehouse instructions, import
orders into an ERP, or automatically optimize/approve/send the new draft.

## API and regression coverage

`GET /api/scenarios/:id/input-update-options?planId=…` lists admitted choices;
adding `datasetId` and `dayId` returns correspondence and policy review inputs.
`POST /api/scenarios/:id/input-update-preview` takes the reviewed intent and a
quoted `If-Match` revision. `POST /api/scenarios/:id/input-update-apply` takes
`{intent, previewSha256, acknowledgeSupersession: true}` with the same revision.
Responses are private and uncached. Preview/apply share one evaluation slot per
replica and return 429 with Retry-After while busy. Application rechecks source
selection, the complete previous cycle, target manifest, membership, handoff
heads and preview identity in its final transaction. No schema migration.

A lost application response can be retried with exactly the same operation ID,
intent, digest and revision. The browser can also recover the immutable result
by verifying that the replacement plan carries that operation ID. It must not
infer success from another operator's unrelated replacement.

Tests cover identity remapping, demand/constraint changes, cancellations, explicit
release/unlock, retained attribution, tenant/role boundaries, membership changes,
two-API competing updates, publication rollback, stale worker fencing, approval
supersession, downstream handoff blocking/cancellation, bound-dataset reads and
native HGS replanning. Production-image Playwright exercises the actual dialog,
duplicate references, recalculated KPIs, lost-response recovery and archived
navigation. Fixtures are synthetic; no production data, email or connector writes
are required. Full customer conversion and production rollout remain separate.
