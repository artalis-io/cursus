# Approval-aware plan handoff

All four existing exports (`export.csv`, `routes.csv`, `routesheet.html`,
`handoff.json`) now carry a server-derived **Draft**, **Approved** or
**Superseded** label. Reviewed is not approved: a reviewed plan exports as Draft.
Ordinary exports remain available for planning and review, including historical
plans. No original/handwritten baseline is required.

## Approval boundary

The stateful server reads the immutable plan, locks its tenant-scoped scenario,
checks the latest approval event, plan hash, current revision and feasibility
evidence, then materializes the complete export bytes before committing. Edits,
deletions and approval transitions use the same scenario-lock boundary. No
network delivery, native execution or external storage request occurs inside
that transaction. Failure rolls back and produces no approved file.

`checkedAt` is the database timestamp for that snapshot. A later edit cannot
retroactively change a downloaded file. Therefore “Approved” means approved at
that timestamp, not permanently current. New exports after an edit are
Superseded. The export hash identifies the canonical stored plan, not the
format-specific output file or normalized display totals.

Append `?approval=required` to any export endpoint for an approved-only handoff.
The server returns HTTP 409 when approval is absent, stale, superseded, or its
validation no longer passes. Other query values return 400. The UI exposes
this mode as **Approved handoff only (JSON)** and handles failure without saving
an error document as a plan. It never relies on a cached UI approval badge.
The browser also requires a matching Approved receipt, revision, plan hash and
workflow version; an old backend ignoring the query cannot cause an unlabelled
response to be saved as an approved file during a rolling upgrade.

Exports require existing `workspace.export` permission, including for Reviewers.
They do not grant review/approval permission and create no jobs, approvals or
emails. Tenant boundaries and Admin View as remain enforced by the same API
access controls. Responses use private/no-store caching and status-bearing
filenames; HTML opens inline, other formats download.

## Version 1 metadata

JSON keeps `otto_dispatch_plan: 1` and adds `handoff`:

- Exact plan/scenario IDs, scenario revision and current scenario revision.
- Canonical stored plan SHA-256, checked-at timestamp and status.
- Approval workflow version, approval timestamp, approver ID/email, identity
  evidence source, and explicit exception acknowledgement where available.
- Stored solver validation and effective per-vehicle GVW/tail-lift/capacity,
  stop time windows/access requirements, and the matching scenario's vehicle
  exclusions, pins, forbids, overrides and locked sequences.
- Exact stored planning policy with approved exceptions, their reasons and
  policy approval provenance. This records existing exemptions; exporting does
  not approve new exceptions.
- Reasons blocking current approval. No missing evidence is invented.

CSV preserves its existing leading columns and adds `handoff_status`, `plan_id`,
`scenario_revision`, `handoff_json`. The first data row's JSON cell contains the
same full metadata and is CSV-escaped; later rows repeat the label/ID/revision,
not the entire evidence inventory. Spreadsheet formula protection remains in
effect. Input mapping can ignore the extra columns. A zero-order CSV carries
one explicitly non-delivery `status=handoff_metadata` row with blank operational
fields, so it still contains its evidence. Do not import that row as an order.

Printable route sheets show the status, revision, approval identity/time and
full evidence, with escaped text and wrapping suitable for long hashes. Keep
the document header/evidence with route sheets when handing them off.

New review/approval events snapshot actor identity and scenario constraints.
Earlier ledger entries remain supported: current directory identity is marked
`user-record`, not falsely claimed to be the historical address. If historical
scenario evidence is absent and the revision changed, it is explicitly
`unavailable`, never replaced with newer edits. Local unauthenticated stateful
development is explicitly identified as `local`, not a named approver. Legacy
file-backed mode can export Draft/Superseded but never Approved; approved-only
downloads return 409. No database migration is required.

## Regression verification

`npm run test:ci` in `server/` covers serializer compatibility, escaping and
legacy fail-closed classification. `npm run test:stateful`, using only the
disposable `compose.integration.yaml` database, includes two API replicas with
separate pools. Controlled transactions test export-before-approval,
export-before-edit and edit-before-export, historical constraints, actor
snapshots, missing scenarios, tenant isolation and absence of write side
effects. Never use a live database for this suite.

`python3 deploy/acceptance.py --report /absolute/path/report.json` builds the
actual application image and exercises two containers with real native Surge,
PostgreSQL and test object storage. Its approval workflow checks ordinary Draft
exports, reviewed-but-Draft, named approval, a Reviewer downloading the approved
file through the UI, and stale approved-only rejection after a peer edit.
No customer data, production credentials or real email delivery is needed.

Keep every writable replica on a compatible implementation. An old server can
still emit unlabelled files; upgrading a single replica is not sufficient to
establish this contract across the whole deployment.
