# Cursus product roadmap

Updated: 12 November 2026  
Status: priorities for review, not authorization to implement or deploy.

## Next milestone: another week of real Gyermelyi data

The next step is to validate the existing product against another complete week
of customer data before adding more features. Exact planning dates and input
versions will come from the supplied files; no new data has been processed as
part of this roadmap update.

Keep the current production configuration stable during preparation. Work from
verified, immutable copies in an isolated environment first. Any production
import, replacement of selected plans or deployment requires its own approval.
Preserve current production plans, approvals and original customer inputs.

### Evidence to collect

1. **Input reconciliation:** inventory orders/deliveries, vehicles, locations,
   windows, capacities, tariffs and source versions for each day. Reconcile the
   imported facts with the source files; identify missing or conflicting facts.
   Record checksums and units without putting private files in Git or images.
2. **Native optimization:** use Surge's hybrid population-based search (HGS).
   Record the executable/graph identities, objective, thread count, runtime
   budget and actual duration. Agree the run settings before execution; this
   document does not change existing defaults or authorize runs.
3. **Independent constraint checks:** verify coverage, duplicate/missing delivery
   identities, payload and pallet capacities, GVW access, tail-lift, time windows,
   operating limits, reload timing, vehicle exclusions and retained assignments,
   sequences and locks. Evaluate stacking/axles only where verified physical
   facts and the supported enforcement mode exist. Missing evidence is Unknown,
   never a passing check. Do not silently relax constraints or invent exceptions.
4. **Dispatcher workflow:** exercise manual assignment/deassignment, stop
   resequencing, exclusion/restoration, route locking, Undo, Replan, candidate
   adoption, reload/recovery and reviewed profile changes. Reconcile displayed
   KPIs and costs with the saved result and exports.
5. **Review and handoff:** verify freshness, explicit exception evidence and
   Draft/Approved/Superseded export status. Validate receiver contracts in dry-run
   or staging only; no production ERP/WMS delivery is implied.
6. **Daily and weekly report:** served/unassigned deliveries and supported
   explanations, distance, vehicles, trips, estimated cost, violations/unknowns,
   solve duration and resource use. If historical customer routes are supplied,
   compare like-for-like scopes and tariffs. Lower service is not savings, and
   historical routes are never required by the core product.

### Completion criteria

- Every supplied day is accounted for, with source-to-import reconciliation.
- Each selected result is reproducible from recorded inputs/settings and passes
  the applicable independent checks; unresolved discrepancies are explicit.
- Manual changes, replanning, retrieval and export agree on identity and KPIs.
- Private evidence remains external. Reusable defects get minimal public
  regression fixtures and authoritative/API/Playwright coverage as appropriate.
- Findings distinguish software defects, missing source facts, genuine
  infeasibility and planner preferences. Use them to adjust the priorities below.

This exercise can validate behavior on real workloads. It cannot establish
physical stacking or axle accuracy without the relevant measurements.

## Subsequent product priorities

These are candidate milestones after the real-data review, not release dates.
The current core/customer boundary is described in
[product scope and customer plug-ins](product-scope-and-customer-plugins.md).

| Order | Capability | Core responsibility | Customer-specific boundary |
|---|---|---|---|
| 1 | Governed constraint exceptions | Extend existing exception evidence with scoped proposals, reasons, Admin approval, impact preview, revocation/expiry semantics and revision-bound enforcement through manual edits, Replan, review and export. Planner proposes; Reviewer inspects. Never relax unrelated constraints or mark an unsafe plan feasible. | Supply factual justification and approved customer policies as external data, never hardcoded order/plate exceptions. |
| 2 | Easier loading-data preparation | Guided preparation and validation of physical units, vehicle geometry and stacking/axle facts for the existing native capabilities. Show completeness, units and provenance; distinguish a schematic from a verified certificate. | Supply measured vehicle/product facts, packaging mappings and approved compatibility rules. No guessed measurements or inferred pallet geometry. |
| 3 | Richer commercial tariffs | Effective-dated carrier/lane/class tariffs, distance bands, additional fees and traceable calculations. Preserve historical rate identity and separate estimated planning cost from quotations/invoices. | Import approved rate files, categories and external exchange-rate references through narrow adapters. |
| 4 | Appointments and depot resources | Model receiving/loading appointments and shared loading-resource capacity consistently across optimization, manual evaluation and review. Validate native support before promising application parity. | Supply bookings, calendars and readiness facts from external systems; Cursus does not own warehouse execution or a booking marketplace. |
| 5 | Customer integration adapters | Reuse the existing acknowledged-handoff contract for exact revisions, idempotency, rejection visibility, amendments/cancellation and recovery. Avoid building a general plug-in platform. | Implement actual ERP/WMS destinations and Gyermelyi-specific mappings with external scoped credentials and separately authorized staging/production writes. |

Existing foundations include tenant/role isolation, durable fenced workers,
immutable admission, manual planning, approval/export safeguards, acknowledged
handoff machinery, operating profiles and
[reviewed profile changes](reviewed-profile-changes.md). The items above extend
these foundations rather than replace them.

## Release guardrails

Keep each feature independently reviewable. Require authoritative validation at
the write boundary, two-replica tests for shared-state changes, tenant/role and
failure-path regression coverage, and exact-image Playwright tests in the
applicable loading modes. Preserve prior plans and approvals; a new result needs
its own approval. Production rollout remains a separate, explicitly authorized
step with backup, readiness and rollback checks.

Infrastructure recovery and backup work remains a separate operational track;
this roadmap neither claims automatic PostgreSQL failover nor authorizes an
infrastructure change.
