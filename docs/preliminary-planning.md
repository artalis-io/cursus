# Editable preliminary datasets

Prepared bundles retain unknown source facts without presenting them as
confirmed. Existing datasets and fleet/tariff settings remain unchanged.
Customer files stay outside source checkouts and Docker build contexts.

`planningEvidence` contains version 1, source SHA-256, `pricing: "unverified"`,
and scoped issues. Preliminary bundles require dataset-specific
`planningSettings`, verified against the native request. Another dataset's fleet
or prices must never be fallback inputs.

Unknown tail-lift requirements remain null. Missing pallet quantities use an
explicit solver lower bound while remaining unknown in displays and exports.
Modelled GVW limits remain separate from source facts. These are preliminary
assumptions, not verified delivery clearance.

Ordered, non-overlapping `time_windows` remain authoritative during validation,
manual editing, previews and replanning. Internal scalar envelopes support
compatibility; native serialization removes them because Surge accepts the
interval representation alone. Profile edits cannot silently collapse intervals.

Plans remain editable and replannable with an EN/HU warning. Unverified monetary
costs are unavailable rather than zero. Draft exports retain intervals and
unknowns. Approval and Approved exports check the admitted dataset in PostgreSQL,
so stripping plan-side warnings cannot bypass the source check.

## Operator sequence

1. Inventory existing IDs/checksums and verify a recoverable database backup.
2. Validate with `preparedBundle` from the candidate image. Rehearse admission,
   native solving, manual edits and exports in isolated PostgreSQL/object storage
   without production credentials.
3. Verify the same compatible image on both replicas before admission. Require
   image label `io.artalis.cursus.capabilities=prepared-planning-v2`.
4. Use prepared-JSON upload, validate, admit. Bind new scenarios explicitly to
   dataset ID, request checksum and day ID. Use new IDs; preserve earlier days.
5. Verify object checksums, per-day inventory, plans and KPIs on both replicas.
   Retain reproducible conversion and solver evidence externally. Do not make
   monetary comparisons without validated tariffs.

Admission records `requiredCapabilities`. The deployment controller checks them
before rollout/rollback and each node update. After admission, an older image
lacking this capability is not a supported rollback target despite an unchanged
SQL schema. Direct Docker commands bypass controller safeguards. Preserve live
writes; never restore an earlier backup over an active database.

## Regression coverage

Domain tests cover windows, unknowns, settings and exports. Two-server PostgreSQL
and S3 tests cover admission, real Surge, manual deassignment, replanning,
cross-instance retrieval, and authoritative approval rejection after stripping
plan-side evidence. Playwright covers EN/HU warnings, cost/served KPIs, intervals,
unknown pallets and unchanged legacy presentation. Deployment tests reject
unsupported rollback images and malformed capability inventories.

Run server `test:ci`, `test:stateful`, browser tests and production-image
acceptance. Stateful/native tests require isolated services and the pinned OTTO
executable. Synthetic tests cannot establish accuracy of unknown customer facts.
