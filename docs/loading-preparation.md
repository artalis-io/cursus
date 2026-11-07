# Physical loading preparation

Physical loading facts can be retained with an admitted prepared JSON dataset.
This is preparation for OTTO's loading checker, not activation of hard loading.
The native dependency is pinned to OTTO `605691491b8199376dc989e440cce13b1fcd705c`
(including loading, cancellation and hot-path fixes). This does not activate hard
loading in Cursus and includes no production rollout.
Gyermelyi continues to use its existing scalar capacities and constraints.

## Import contract

Use the existing prepared JSON upload, validation and admission API. Its existing
`dataset.upload` permission and tenant isolation apply. CSV/XLSX conversion does
not invent physical geometry. There is no separate loading-only upload or editor.

Add `physicalLoading` alongside `surgeRequest`, `days`, `geocoded` and optional
`shipments`. The TypeScript contract is `server/src/loading-contract.ts`.

- `schemaVersion`: 1; `mode`: **disabled**, required.
- `datasetSha256`: SHA-256 of UTF-8 `JSON.stringify(surgeRequest)`, without
  physical loading metadata in the request. The server checks this binding.
- `vehicles`: exactly one declaration per native vehicle ID, including unused
  vehicles. Each requires `vehicleId`, `slotCount` (1–128), `maxLayers` (1–8),
  `clearanceMm`, `maxStackWeightG`, `payloadG`, `access` (`side_free` or
  `rear_lifo`), `allowedTop` and `slots`.
- `allowedTop`: one array per bottom support class, listing the class IDs allowed
  immediately above it. Direction matters. At most 64 classes, zero-based.
- `slots`: exactly `slotCount` unique `{lane, depth}` coordinates. Depth increases
  away from the rear door. This model assumes identical full-footprint slots.
- `requests`: exactly one `{requestId, units}` declaration per native request ID.
  Each physical unit requires `id`, `heightMm`, `weightG`, `stackClass`,
  `maxWeightAboveG`, `maxUnitsAbove`. IDs are unique within each request.
  Units are discrete, never fractional pallet equivalents. Zero weight/count
  above means no such load may be placed above the unit.

Numbers must be non-negative safe integers; height/clearance must be positive.
Class IDs must exist on every vehicle. Unknown fields, incomplete inventories,
unsupported pickup/open-start/initial-load models and foreign checksums fail
validation. The current import limits are 128 units per request and 100,000 units
per dataset. This does not imply that a round exceeding the native checker limit
can later be certified.

No height, support strength, stack count or weight is inferred from commercial
lines, net weight, `stackable`, or a fraction such as 0.5 pallets. Customers must
supply verified physical facts before a future activation.

## Admission and display

Upload using `POST /api/import/upload` (multipart JSON file), then use
`POST /api/import/datasets/:id/validate` and `/admit`. Only admitted datasets are
solver-visible. Existing upload authorization, tenant-scoped checksum-addressed
objects and the transactional admission boundary are reused.

The physical declaration becomes a separate immutable object, listed in the
admitted manifest as `artifacts.physicalLoading`. Loading it verifies its object
checksum, tenant namespace and dataset identity. The native request remains
unchanged; an embedded native `loading` field is rejected, not silently enabled.

Plans retain the physical source checksum and per-round unit counts. Open the
plan status details, then Constraints → Physical loading. EN/HU text explicitly
says **Not evaluated** and **Hard loading is disabled**. Historical plans without
physical facts say that pallet equivalents do not prove loading feasibility.
Manual edits rebuild counts from current facts rather than inheriting the old
layout. No physical feasibility certificate, axle-load guarantee or approval
claim is produced. Existing approval behavior is unchanged.

## Verification

Run `npm run test:ci` in `server`, and `npm run build` in `web`.
`server/src/loading.test.ts` covers malformed declarations, sparse request IDs,
immutable admission, cross-tenant rejection, checksum tampering and manual round
refresh. `test:stateful` includes the real PostgreSQL/S3 two-API admission test.
`web/acceptance/loading-evidence.spec.ts` checks browser rendering, bounded checksums,
EN/HU copy and legacy fallback. Browser presentation tests use public fixtures;
the separate stateful integration test uses actual disposable storage services.

Future activation must pin merged OTTO code, map stable IDs to native indices,
carry ordered round certificates, reject UNKNOWN at publication, invalidate
certificates after edits, and add approval/API/export regression coverage. That
activation requires verified customer geometry and a separate implementation.
General 3D packing, reshuffling and axle loads remain outside this milestone.

## Production-image integration gate

`python3 deploy/acceptance.py --report /external/evidence/report.json` builds the
local image, runs the pinned OTTO native loading contract inside that image,
and tests two application replicas against disposable PostgreSQL/S3 storage.
It does not need customer data or production credentials.

The native gate reuses OTTO's CLI fixtures and independent Python reference
validator through read-only mounts. It covers stackable versus non-stackable
units, legacy mode, budget exhaustion (UNKNOWN), reload rounds, malformed input,
and impossible height/payload loads. Every successful solution is independently
replayed for coverage, geometric distance, scalar capacity and physical witnesses.
The report records the fixture hash and executable hash; the latter must match
its ordinary runtime provenance. No solver or converter is duplicated in Cursus.

`web/acceptance/zzz-loading-admission.spec.ts` uploads physical facts through
real authenticated multipart HTTP, rejects admission before validation, admits
through the peer, executes a native optimization, retrieves its immutable plan
through the other replica and checks the EN/HU loading evidence. Attempting to
set `mode: hard` remains rejected. Facts and round counts must survive, while
status remains **Not evaluated**. This tests the current application boundary;
it is not evidence of active stacking enforcement by Cursus HTTP handlers.

The native tests exercise hard stacking directly, without exposing a bypass API.
Activating it through Cursus still needs a separately reviewed stable-ID adapter,
publication/approval/export validation and verified customer loading geometry.
No loading dimensions or stacking permissions are inferred for Gyermelyi.
