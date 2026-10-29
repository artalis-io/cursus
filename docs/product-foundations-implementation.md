# Product foundations implementation

Status: implemented on `feat/product-planning-foundations`; review and validation evidence are tracked in [PR #42](https://github.com/artalis-io/cursus/pull/42). Production activation is separate.

Progress:

- Candidate-safe Replan and stable identity: committed as `db42035`; 68/68 isolated production-image Playwright tests passed. Later profile/shipment work adds regression protection for subsequent manual selection and portable-file compatibility.
- Profiles and canonical shipment metadata: implemented; native unit, two-replica HTTP/integration, frontend build and deployment-tool checks pass. Browser testing found and fixed positional stop selection and a reopen/manual-mode navigation race. The complete corrected 74-test production-image suite passes on AMD64 in CI; ARM64 verification is recorded separately in the PR.
- Revision-bound acknowledged handoff: implemented with immutable intents, bounded leased delivery, receipt-only ambiguous recovery, amendment/cancellation, Admin permissions, complete delivery-identity checks and an opt-in receiver contract. Real local HTTP crash/takeover tests and the production-image browser workflow pass. No production destination is configured or contacted.

Implementation validation at `35a3543`: 198 server checks with native Surge enabled; 39 integration tests passed and two optional private-data tests skipped; 101 deployment/HA Python tests passed. Frontend build and browser TypeScript compile pass; lint has zero errors and five existing hook warnings. GitHub's six release checks are green, including 74/74 AMD64 production-image browser tests without retries or skips. CI's merge tree exactly matches this implementation commit. Private customer/geographic acceptance and production rollout were not performed.

Implement in this order:

1. Candidate-safe replanning and stable delivery identity throughout comparison and manual selection. Preserve both results and their approval evidence; explicit adoption must not confer approval. Legacy ambiguous references fail closed.
2. Tenant-scoped, versioned location and fleet/configuration profiles with review permissions, immutable revisions and explicit activation. Existing external fleet settings remain supported during transition.
3. Canonical shipment, delivery, line-item and physical load-unit metadata, with explicit units and conservative split rules. Existing admitted datasets remain valid; no automatic customer-data migration or inferred capabilities.
4. Approved, revision-bound integration handoff with idempotency, acknowledgements, retry, amendments and rejection visibility. Customer destinations and credentials remain external; no production connector writes during implementation.

Use existing PostgreSQL transactions, leases/fencing, immutable objects, role checks and native OTTO machinery. No new infrastructure or orchestration platform.

Each milestone must include authoritative server tests, cross-instance integration coverage where state changes, and Playwright tests of the user workflow. Exercise duplicate display references, stale revisions, tenant boundaries, permissions, reload/recovery and partial failures. Do not claim native or private-data tests that were not executed.

Preserving a prior result does not make it feasible under later edits. Candidate adoption must recheck current tenant/scenario/revision and policy evidence. An adopted result remains Draft unless separately reviewed and approved at that exact revision.

Design references: [usability review](usability-review.md) and [core/customer boundary](product-scope-and-customer-plugins.md).
