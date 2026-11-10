# Actionable approval blockers

Approval remains an authoritative server decision. This change adds explanations and read-only navigation to the existing review disclosure; it does not change approval rules, solve parameters, datasets or constraints.

## Server evidence and compatibility

Workflow responses preserve the existing `blockers: string[]` and add optional version-one `blockerDetails`: exact plan/scenario IDs, plan/current revisions, immutable plan hash, reason codes and navigation targets. Core reasons are emitted where approval checks run, without parsing English text. Existing fleet/tariff and physical-loading failures receive their own categories. The legacy string list is still the approval gate, with its existing messages and deduplication.

Targets describe an existing section, vehicle, trip or delivery. A delivery target includes its vehicle, trip, sequence, order reference and request ID when available. No target can request a mutation or arbitrary URL. An older client ignores the extension. A newer client accepts an older response but cannot invent structured reasons or navigation from its English strings.

The browser validates the extension against the workflow hash/revisions, expected plan and scenario. It requires every string blocker to be represented and rejects contradictory, malformed or borrowed evidence. Invalid evidence becomes Unknown, disables approval and exposes Retry. Missing legacy details keep approval blocked and explain that detail is unavailable.

## User workflow

- English and Hungarian show the same structured reason categories and recovery guidance.
- Constraint blockers link to the exact delivery, trip or vehicle where safely identifiable.
- Coverage and validation blockers open the existing Issues dialog. Readiness also provides direct links to unassigned deliveries.
- Input/policy evidence links to the existing constraint/loading detail sections.
- Revision drift offers review of known changes or explicit scenario reload. Equal revision numbers from different scenario IDs never authorize opening the other scenario’s change list. Reload retains the displayed saved plan; it does not adopt a result, solve or change constraints. It is disabled during saving, running optimization or a candidate decision and uses the existing navigation safeguards.
- Inspector navigation collapses the review disclosure and transfers keyboard focus to the inspector heading.

Reviewer navigation is read-only. Existing role checks continue to control editing, review and approval. Opening a blocker never executes a suggested repair, relaxes a constraint, submits optimization or transfers approval.

## Identity and failure behavior

A supplied delivery ID never falls back to an order number. Duplicate order numbers remain distinct through approval evidence, Issues and readiness navigation. Conflicting or ambiguous historical identities receive an explanation instead of a guessed destination. Exact stop targets also verify the vehicle/trip/sequence against the displayed snapshot.

Approval evidence remains version-bound and periodically rechecked by the existing owner. Failed reads hide previous actionable evidence; delayed responses cannot populate a different plan. New detail metadata has no per-read timestamp, so ordinary polling does not clear approval acknowledgements unnecessarily.

## Regression evidence

Tests cover the unchanged legacy approval gate, per-delivery/trip targets, duplicate labels, missing evidence, cross-replica revision changes and rejected stale approval. Browser tests exercise real manual invalid drafts in EN/HU, Reviewer navigation through duplicate unassigned deliveries, explicit reload after peer edits, malformed/borrowed metadata and legacy compatibility. Pure tests reject stale positions, missing IDs, conflicting references and omitted blockers.

The normal server, PostgreSQL integration and exact-image Docker/Playwright suites remain release checks. Private fixtures and production state are not required for these regressions. Production activation is a separate approval.
