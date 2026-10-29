# Cursus product scope and customer plug-ins

Date: 28 October 2026  
Status: proposed product boundary and roadmap; not an implementation commitment.

## Purpose

Translate the supplied transport-planning process description, dated 27 February 2025, into reusable Cursus capabilities and potential Gyermelyi-specific integrations.

The supplied description is evidence of that documented workflow, not independent confirmation of today's systems, interfaces, or regulatory requirements. Customer identifiers, credentials, private datasets, rate cards, and internal mappings must remain outside the repository.

This is a preliminary assessment of the application workflow and data contracts. It is not a complete audit of every capability already available in OTTO's native engines.

Related documents:

- [Workflow and usability review](usability-review.md)
- [Manual planning](manual-planning.md)
- [Plan review and freshness](plan-review-and-freshness.md)
- [Approved-plan handoff](approved-plan-handoff.md)
- [Workflow roadmap](workflow-roadmap.md), which contains historical implementation status and should not be treated as a current feature inventory.

## Product boundary

Cursus owns the planning decision: admit a verified input snapshot, construct and optimize trips, let a planner revise them, explain the result, obtain revision-bound review/approval, and hand the chosen plan to other systems.

Upstream and downstream systems retain ownership of commercial orders, stock, warehouse execution, legal documents, physical transport execution, and accounting. Cursus owns its planning snapshots, scenarios, results, decision history, and approval evidence; this does not make it the operational system of record for those external domains.

Existing foundations include manual planning, scenarios, key hard constraints, tenant/role isolation, immutable dataset admission, durable workers, approval, and revision-bound exports. Extend these foundations rather than rebuilding them.

## Scope labels

| Label | Meaning |
|---|---|
| **CORE** | Reusable product capability, independent of one customer's systems, terminology, files, or business identities. |
| **CORE INTERFACE** | Shared, versioned import/export and integration contract. A customer adapter implements it. |
| **GYERMELYI PLUG-IN** | Optional customer adapter, mapping, template, or configuration implementing the shared contract. It must not bypass core validation or authorization. |
| **EXTERNAL / OPTIONAL MODULE** | Outside the current planning core. A separately scoped product/module or an external system may own it. |

CORE means within the intended product boundary, not necessarily implemented or scheduled for the next release. A Gyermelyi plug-in is a proposed packaging boundary; this document does not establish that a plug-in runtime already exists. A small adapter or configuration package may be sufficient.

Reusable JDE or WMS connectivity can later become a shared connector. Gyermelyi's table mappings, custom messages, identifiers, deployment settings, and workflow choices remain customer-specific.

## Capability and ownership matrix

| Capability | Core product responsibility | Potential Gyermelyi plug-in | Boundary / current assessment |
|---|---|---|---|
| **Orders, deliveries, order lines, and load units** | **CORE:** distinguish commercial order, delivery, line item, and physical load unit. Preserve stable external identities, consolidation, and explicit split-delivery rules. | **GYERMELYI PLUG-IN:** map the documented JDE header/line/address records, company identifiers, product groups, units, and packaging into the canonical model. | Current order-oriented planning is a foundation; a complete line-item/load-unit workflow needs further work. Do not move commercial order entry or approval into Cursus. |
| **Trips independent of confirmed vehicles** | **CORE:** create a draft trip before its contents or physical vehicle are confirmed; assign deliveries and then suitable capacity. Distinguish direct and multi-drop service patterns. | **GYERMELYI PLUG-IN:** map körfuvar/célfuvar terminology, external tour numbers, local defaults, and business cutoffs. | A required capacity profile is not a verified truck. Conditional feasibility must be visible until required evidence is confirmed. |
| **Location and handling constraints** | **CORE:** structured site profiles for GVW, configuration, dimensions, equipment, unloading assistance, hours, and service duration; include provenance, verification, and approved exceptions. | **GYERMELYI PLUG-IN:** translate approved spreadsheet conventions, source fields, and verified operational knowledge into these profiles. | GVW, tail-lift, and time-window handling already exist in part. Do not encode restrictions solely in customer names, cell colors, or free text. |
| **Carrier and fleet resources** | **CORE:** separate carrier, physical vehicle, capacity commitment, and tractor/trailer configuration; support dated availability and service/lane eligibility. | **GYERMELYI PLUG-IN:** map supplier IDs, vehicle/configuration records, regional carrier lists, and capacity commitments from approved sources. | Current fleet metadata and unavailable-vehicle policy are foundations. Do not invent registrations, equipment, availability, or GVW for provisional capacity. |
| **Capacity and loading feasibility** | **CORE:** distinguish cargo net/gross weight, payload, and vehicle GVW. Model pallet floor positions, stackability, packaging types, and additional capacity dimensions where supported. | **GYERMELYI PLUG-IN:** provide product/pallet mappings and approved stacking rules, including full/mixed pallet definitions. | Current application workflows primarily expose kg and pallet capacity. Generic loading semantics precede a full packing feature. |
| **Load visualization and loading order** | **CORE, phased:** explain occupancy and unload accessibility; produce a loading-order recommendation linked to the stop sequence. Clearly distinguish verified feasibility from a schematic view. | **GYERMELYI PLUG-IN:** transform that recommendation into the customer's WMS release/picking sequence and rendering conventions. | Full 3D packing, axle-load validation, and detailed loading algorithms require separate engineering scope. A picture is not a feasibility certificate. |
| **Pickup, loading, and delivery scheduling** | **CORE:** distinct dates/windows, time zones, calendars, multiple origins/depots, and loading durations. Incorporate appointments and loading-resource constraints where required. | **GYERMELYI PLUG-IN:** map local pickup commitments, appointment references, warehouse readiness, and site calendars. | Existing delivery windows and vehicle shifts are partial support; multiple-depot and additional-demand-dimension workflows need explicit application validation. |
| **Order eligibility and readiness** | **CORE INTERFACE + CORE:** consume authoritative planning eligibility/readiness with source, timestamp, and reason; enforce blockers and expose actionable explanations. | **GYERMELYI PLUG-IN:** map commercial holds, release restrictions, cancellations, and warehouse readiness from the appropriate source systems. | Do not recreate credit control, payment collection, or stock management. Show only the information a planning role needs. |
| **Rolling input changes and committed work** | **CORE:** admit revised snapshots, explain impact, invalidate affected evidence, preserve committed work, and replan the editable remainder. | **GYERMELYI PLUG-IN:** supply updated quantities, readiness, confirmed commitments, and loaded/departed restrictions from external systems. | Revisions and locking are foundations. Physical execution remains external; do not silently alter work already accepted or performed downstream. |
| **Commercial rate cards and cost explanation** | **CORE:** versioned, effective-dated carrier/lane/class tariffs; distance bands, drops, additional charges, currencies, and traceable calculation breakdowns. | **GYERMELYI PLUG-IN:** import approved carrier rate files and map categories, cost centres, charges, and externally supplied exchange-rate references. | Current per-vehicle/per-trip tariffs are partial support. Keep estimated cost, accepted quotation, and actual invoice amounts distinct. |
| **Reliable plan transfer** | **CORE INTERFACE:** stable external IDs, exact approved revision, idempotent delivery, acknowledgement, retry, failure visibility, and controlled amendment/cancellation. | **GYERMELYI PLUG-IN:** implement customer-specific JDE/Wamas/gate-system messages and translations of acceptance or rejection responses. | Exports already exist. Downloading a file is not proof that another system accepted the revision. No direct ERP table writes belong in core domain logic. |
| **Transport instructions and document packs** | **CORE:** configurable planning instruction templates, attachments/references, and revision-bound handoff evidence. | **GYERMELYI PLUG-IN:** map local fuvarigény/fuvarozási megbízás layouts, recipients, references, and approved document templates. | Core planning instructions must not be misrepresented as legally sufficient delivery, financial, or specialist certificates. |
| **Regulatory and specialist document references** | **CORE INTERFACE:** attach opaque external document IDs, status, provenance, and required-reference checks configured for the workflow. | **GYERMELYI PLUG-IN:** optional EKÁER/E-Transport adapters and mappings to quality/veterinary certificate services, subject to separate requirements validation. | Regulatory rules can be jurisdiction/industry-specific and change. Validate current schemas, responsibilities, permissions, and legal requirements before implementation. Cursus should not infer compliance from a populated reference field. |
| **Returns and returnable packaging in planning** | **CORE:** planned collections, return loads, and packaging capacity effects. | **GYERMELYI PLUG-IN:** map packaging types, expected returns, and external balance references. | Pallet ownership, rental charges, settlements, and balances remain **EXTERNAL / OPTIONAL MODULE** responsibilities. |
| **Collaboration and planning audit** | **CORE:** conflict-safe editing, actor/revision evidence, clear ownership, and optionally editing presence. | **GYERMELYI PLUG-IN:** map organizational groups or externally supplied permissions through supported identity interfaces. | Roles, tenant boundaries, optimistic concurrency, and manual history already exist. Presence is a convenience, not a substitute for authoritative concurrency checks. |

## Workflow mapping from the supplied process

| Supplied process section | Product disposition |
|---|---|
| 2.1–2.2: order entry and commercial approval | **EXTERNAL:** ERP owns entry/approval. **CORE INTERFACE:** import the approved planning snapshot and eligibility. **GYERMELYI PLUG-IN:** JDE mappings. |
| 2.3.1–2.3.3: daily view, new trips, order assignment | **CORE:** planning navigation, trip construction, line-item inspection, aggregate KPIs, manual and automatic assignment. |
| 2.3.4: carrier tendering and booking confirmation | **EXTERNAL / OPTIONAL MODULE:** procurement/booking workflow. **CORE:** compare eligible capacity and planning cost; consume confirmed capacity through an interface. |
| 2.3.5: vehicle selection | **CORE:** suitable resource/configuration assignment and confirmation evidence. **GYERMELYI PLUG-IN:** local supplier/vehicle mappings. |
| 2.3.6: transport requests/instructions | **CORE:** revision-bound planning instructions. **GYERMELYI PLUG-IN:** customer layouts and delivery destinations. |
| 2.3.7: EKÁER/E-Transport | **GYERMELYI PLUG-IN / reusable jurisdiction connector:** external submissions and references, with separately validated compliance scope. |
| 2.3.8–2.3.9: planning completion and auxiliary files | **CORE:** review/approval, configurable handoff, governed constraints and provenance. **GYERMELYI PLUG-IN:** external notification destinations and source mappings. Approval is not warehouse release. |
| 2.4: commercial and warehouse statuses | **CORE INTERFACE:** consume relevant external status and blockers. **EXTERNAL:** own the actual commercial/warehouse state transitions. |
| 2.5: warehouse release, picking, loading order, ERP updates | **CORE:** loading feasibility and planning recommendation. **GYERMELYI PLUG-IN:** acknowledged WMS/ERP exchange. **EXTERNAL:** inventory allocation, picking, stock issue, and ERP postings. |
| 2.6–2.7: official documents and physical distribution | **CORE:** planning pack and external references. **GYERMELYI PLUG-IN:** templates/service adapters. **EXTERNAL:** official document issuance and physical distribution. |
| 2.8–2.9: appointment booking | **CORE:** plan against appointment constraints. **GYERMELYI PLUG-IN:** retrieve/reference bookings from relevant customer services. Owning a booking marketplace is separate scope. |
| 2.10–2.11: gate management and weighbridge | **EXTERNAL:** operate gates, ramps, scales, device protocols, and measurements. **GYERMELYI PLUG-IN:** read relevant readiness/actual-weight evidence and transfer approved planning references where authorized. |
| 2.12–2.13: transport execution and returned delivery notes | **EXTERNAL / OPTIONAL MODULE:** live execution and proof-of-delivery tracking. **CORE INTERFACE:** expose references or consume facts needed for replanning. |
| 2.14: pallet tracking | **CORE:** expected pickups/returns and capacity effects. **EXTERNAL / OPTIONAL MODULE:** pallet ledger, ownership, billing, reconciliation, and settlement. |
| 2.15: freight rates and settlement | **CORE:** explain estimated planning cost using versioned tariffs. **GYERMELYI PLUG-IN:** rate imports and external cost-centre mappings. **EXTERNAL:** invoicing, accounting, and settlement. |

## Important modelling rules

### Capacity must be explicit

Stackable pallets are not simply double pallet capacity. Product compatibility, packaging, layer limits, height, weight, unload access, and stop order can affect feasibility. Preserve a distinction between fractional commercial pallet quantities and physical floor positions/load units.

Unknown data must remain unknown. A required vehicle profile can support conditional planning, but it must not masquerade as a confirmed physical vehicle. Required evidence must be resolved before the relevant approval/handoff gate.

### External status is not Cursus approval

Keep these dimensions separate:

- Planning feasibility and completeness.
- Plan freshness and revision-bound human review/approval.
- Technical delivery and acknowledgement of a handoff.
- External warehouse or transport execution state.

A warehouse-ready event does not approve a plan. A Cursus approval does not issue stock. An acknowledgement confirms acceptance of a particular revision, not completion of transport.

### Changes after handoff require a protocol

Do not reproduce the documented send-once behavior in which later changes disappear from the receiving system. Track the accepted revision, identify affected downstream commitments, and require an explicit amendment/cancellation or operator resolution. Repeated delivery must not duplicate tours, stock movements, bookings, or documents.

## Proposed plug-in contract and safeguards

Start with narrow adapters using existing application tooling and durable-job infrastructure. Do not build a general plug-in platform or introduce another orchestration system before concrete integration needs justify it.

A customer integration should declare:

- Its supported contract version, configuration schema, and capability set.
- External ID mappings, units, time zones, source versions, and validation rules.
- Read/write permissions, explicit destinations, and tenant boundary.
- Idempotency, acknowledgement, retry, reconciliation, and amendment behavior.
- Which system owns each field and state transition.

Core must enforce:

- Tenant isolation, roles, immutable admission, schema validation, fencing, and approval/export rules regardless of the adapter.
- Authenticated and authorized integration entry points, with scoped credentials installed externally.
- No cross-tenant or implicit node-local fallback.
- No customer credentials, private templates, datasets, rate cards, or internal source mappings in images or public source control.
- Dry-run and replay testing with non-confidential fixtures; authorized staging before production writes.
- Transparent failures and reconciliation. Adapter failure must not silently mark a plan delivered, feasible, or approved.

Customer-specific exceptions must be data with provenance and approval, not hidden code branches for an order number, plate, customer name, or dataset filename.

## Generic product acceptance baseline

The product must operate from orders/deliveries, fleet or declared capacity, locations, and constraints alone. Historical handmade routes or initial solutions may be optional inputs; they must never be prerequisites.

At least one non-Gyermelyi fixture should prove:

- New planning from a fresh dataset, without a historical plan or customer-specific filenames.
- Stable identities across order lines, repeated order references, split/consolidated deliveries, and external systems.
- Explicit units and correct distinctions between cargo gross weight, payload, and vehicle GVW.
- Safe treatment of unknown capabilities and provisional capacity.
- Consistent constraints and costs through native optimization, manual edits, review, and export.
- Safe inbound updates, committed-work restrictions, and acknowledged revision handoff.
- Tenant isolation and concurrent operation across replicas.

For every customer adapter, test duplicate messages, partial failures, stale revisions, retries, rejected acknowledgements, and changes after downstream acceptance. Validate capability support end to end; a native-engine feature alone does not establish application/UI parity.

## Recommended sequence

1. **Canonical shipment model and integration contract:** stable identities, order lines/load units, eligibility, revisioned inputs, and acknowledged handoff.
2. **Governed location, fleet/configuration, and carrier profiles:** replace implicit spreadsheet knowledge with verified, versioned planning data.
3. **Capacity/loading semantics:** stackability, physical positions, additional dimensions, returns, and an honest loading visualization.
4. **Appointments, readiness, and committed-work replanning:** integrate external facts without taking ownership of warehouse or transport execution.
5. **Richer tariffs and configurable planning packs:** explain costs and deliver the approved revision through customer adapters.

Apply the [usability review](usability-review.md) alongside these milestones, especially stable delivery identity, comparison correctness, explicit candidate adoption, clear approval status, and reliable plan navigation.

No production integration, regulatory submission, ERP/WMS write, code change, or deployment is authorized by this assessment. Each implementation needs its own concrete contract, validation evidence, and operational scope.
