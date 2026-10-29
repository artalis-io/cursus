# Versioned planning profiles and shipment metadata

Implementation milestone 3/4. Production activation is separate.

## Profile governance

The stateful runtime stores tenant-scoped fleet and location profiles in PostgreSQL. Content revisions and their checksums are immutable. Planners can propose revisions; only Admins can approve and activate them. Reviewers can inspect them. Mutations recheck membership inside the transaction, and optimistic versions serialize competing proposals or activations across replicas.

Activation changes the catalog's preferred revision. It does not change an existing scenario. A dispatcher explicitly pins approved revisions to a scenario, advancing its planning revision and requiring Replan. Older approved revisions remain selectable and auditable. At most one fleet and one location profile can be pinned. Both must match the exact admitted request checksum. Changing profiles with retained manual decisions requires a clean scenario; the application does not silently reinterpret those decisions.

The **Planning profiles** dialog supports proposing from trusted current settings, reviewing facts and rates, approving, selecting and inspecting revision history. External read-only fleet settings remain supported when no fleet profile is pinned. Legacy JSON runtime does not advertise or apply profiles.

Fleet revisions contain equipment, GVW, payload and pallet capacities, eligibility, reload durations, configuration references and the tariff snapshot. Available vehicles require verified GVW; payload cannot exceed GVW. Scenario capacity reductions remain possible, but cannot exceed an approved fleet profile's capacity ceiling. Location revisions contain explicit destination GVW access, tail-lift requirements, service durations and opening/deadline windows. Coordinates and matrices are not editable through this facility; a geographic change requires new preparation/admission.

Profiles are initially dataset-scoped. Native vehicle/configuration rows remain the execution identity. The application does not infer shared physical tractors or trailers from similar names, and this milestone does not introduce shared-equipment scheduling or a global address-book reconciliation system.

API:

- `GET /api/profiles`: tenant revision inventory and approval/activation evidence.
- `GET /api/profiles/template?planId=…&kind=fleet|locations`: trusted current source facts, with an empty change reason.
- `POST /api/profiles`: propose `{content}`, with `If-Match: "0"`.
- `POST /api/profiles/:id/revisions`: propose immutable content using the current profile version.
- `POST /api/profiles/:id/activate`: approve/activate `{revision}`, using the current profile version.
- `POST /api/scenarios/:id/profiles`: pin `{profiles:[{id,kind,revision,sha256}]}`, using the scenario revision.

The content contract is [planning-profile-contract.ts](../server/src/planning-profile-contract.ts). No customer profiles, rate cards or identities belong in Git.

## Commercial and physical identity

The additive shipment contract distinguishes:

- Commercial shipments and their source references.
- Line items, explicit quantities and units, and optional net/gross weights.
- Atomic delivery requests, dates, locations and line-item allocations.
- Physical load units, integer quantities, optional weights/volumes and known/unknown stackability.

A repeated display reference does not merge deliveries or commercial records. Delivery IDs and native request IDs are scoped by the immutable request checksum. Allocations must account for every line quantity exactly and agree with native planning weights and pallet equivalents. A shipment defaults to indivisible. An explicit split must already be represented as separately identified native deliveries; Cursus does not silently split an order.

`weightBasis` is explicit (`gross`, `net`, or `unspecified`). A declared basis requires agreeing source line weights. Physical load-unit quantities are not interchangeable with fractional pallet equivalents. Spatial packing, stacking feasibility and axle loads are not certified by this metadata or by a two-dimensional solver result; the inspector states that limitation.

## Admission and compatibility

Existing admitted artifacts remain readable. No customer dataset is rewritten or automatically migrated.

Native CSV/XLSX conversion still uses Nexus, the existing geocoder and Velo matrix builder. It now persists the exact generated row-to-request mapping and publishes an additional checksum-addressed shipment artifact. These conversions produce honest delivery summaries: they do not invent SKU lines, commercial grouping or packaging detail that the mapped source did not supply. The conversion fingerprint includes the additive identity/metadata version, along with existing actual executable and graph hashes.

Integrations can supply richer metadata through the existing JSON-bundle upload API. An extended prepared bundle contains:

```text
schemaVersion: 1
days: [{dayId, isoDate, date?, label?}]
surgeRequest: existing two-dimensional, single-depot native request
geocoded: [{request_id, order_no, delivery_date,
            requires_tail_lift, max_gross_weight_kg, …display fields}]
shipments?: ShipmentDocument
```

`ShipmentDocument` is defined in [shipment-contract.ts](../server/src/shipment-contract.ts). Its `datasetSha256` must equal SHA-256 of the exact UTF-8 `JSON.stringify(surgeRequest)` bytes. The server checks inventory, dates, matrices, explicit access facts, allocations and totals before validation. Missing rich metadata produces a summary only when exact request identities are available. Historical legacy bundles without these prepared fields retain their existing archival admission behavior; they are not converted into solver-ready input by assumption.

Upload, validate and admit use the existing `/api/import/upload`, `/api/import/datasets/:id/validate` and `/api/import/datasets/:id/admit` endpoints. Immutable artifact uploads occur outside the publication transaction. Only a successful, validated database admission makes the manifest visible. Native background conversion retains its existing lease and fenced admission boundary. Interrupted uploads can leave harmless staged objects; this milestone does not delete them automatically.

Solving and manual planning use exact per-delivery source facts. Plan snapshots retain scoped shipment details and their source checksum. The inspector and JSON handoff expose those details without recalculating served counts from line-item or load-unit counts. Missing historical detail is reported as unavailable.

## Portable scenarios and deployment

Dataset-bound edits and profile references export as `otto_scenario: 2`. New importers accept versions 1 and 2 and resolve profile references against approved revisions in the receiving tenant. Older importers reject version 2 instead of silently dropping identity or profile constraints. References never grant approval in another tenant.

Schema migration 4 adds profile tables and immutable revision protection. Application images declare support for schemas 1–4. Although the SQL addition is additive, older schema-3 applications do not understand pinned profile semantics; deployment tooling must refuse that rollback against schema 4. Do not restore an earlier database over new writes as an application rollback. Any later production rollout needs its normal migration, backup and compatibility review.

Validation includes strict domain tests, two-replica profile races/permissions, a real HTTP prepared-data → immutable admission → approved profiles → native Surge → peer retrieval/export test, and production-image Playwright coverage. Test evidence must distinguish executed synthetic workflows from optional private/customer and geographic tests.
