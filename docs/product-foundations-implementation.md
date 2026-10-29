# Product foundations implementation

Status: authorized implementation, in progress. Production activation is separate.

Implement in this order:

1. Candidate-safe replanning and stable delivery identity throughout comparison and manual selection. Preserve both results and their approval evidence; explicit adoption must not confer approval. Legacy ambiguous references fail closed.
2. Tenant-scoped, versioned location and fleet/configuration profiles with review permissions, immutable revisions and explicit activation. Existing external fleet settings remain supported during transition.
3. Canonical shipment, delivery, line-item and physical load-unit metadata, with explicit units and conservative split rules. Existing admitted datasets remain valid; no automatic customer-data migration or inferred capabilities.
4. Approved, revision-bound integration handoff with idempotency, acknowledgements, retry, amendments and rejection visibility. Customer destinations and credentials remain external; no production connector writes during implementation.

Use existing PostgreSQL transactions, leases/fencing, immutable objects, role checks and native OTTO machinery. No new infrastructure or orchestration platform.

Each milestone must include authoritative server tests, cross-instance integration coverage where state changes, and Playwright tests of the user workflow. Exercise duplicate display references, stale revisions, tenant boundaries, permissions, reload/recovery and partial failures. Do not claim native or private-data tests that were not executed.

Preserving a prior result does not make it feasible under later edits. Candidate adoption must recheck current tenant/scenario/revision and policy evidence. An adopted result remains Draft unless separately reviewed and approved at that exact revision.

Design references: [usability review](usability-review.md) and [core/customer boundary](product-scope-and-customer-plugins.md).
