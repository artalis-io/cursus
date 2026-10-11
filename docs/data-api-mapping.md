# Cursus — Data & API mapping

This slice is a dispatch-planning workspace over a sample logistics dataset, with
**Surge** as the optimization backend, **Carta** for tiles, **Velo** for road
geometry, and a thin app backend (`server`). This document is the contract
the frontend codes against and the mapping from source data + Surge output into
that contract. It is intentionally concise; see the inline source references.

## Components & ports (local / Spark)

| Service | Role | Port | Binary / entry |
|---|---|---|---|
| Backend | app backend: scenarios, plans, jobs, provenance, proxy, narration; serves the SPA | 8091 | `server` (Node/TS) |
| Carta | vector tiles (Hungary) | 8097 | `carta/api/carta-tile-server -p 8097 data/index/hungary-carta.idx` |
| Velo | road geometry (truck) | 8082 | `velo/api/velo-route-server data/index/hungary-velo.vlg` |
| Surge | VRP solve (via CLI) | n/a | `surge/surge_solve <request.json> > solution.json` |
| Sage | LLM narration (optional) | 8084 | DGX Spark `:8084/v1` (OpenAI-compatible, `enable_thinking:false`) |

the backend shells `surge_solve` as a child process (optimization stays in C/Surge; the
work runs off the backend's event loop by construction). Geometry is fetched from Velo
**once per plan** and cached with the plan — never per selection change.

## Source data (immutable; NOT in repo)

Root: `/Users/mark/artalis.io/data/dataset/` (client data, deliberately
uncommitted). the backend reads it read-only; scenario edits never touch it.

- **Planning days**: `2026-05-06` (Day 1: 117 orders, 11 vehicles) and
  `2026-05-07` (Day 2: 146 orders, ~19 vehicles). Each solved independently.
- **Per-day Surge request** (solver input, carries all 264 locations + matrix +
  that day's vehicles): `results/perday/day{1,2}_request.json`.
- **Per-day saved real solution** (baseline plan): `results/perday/day{1,2}_solution.json`.
- **Human order table**: `deliverables/inputs/orders_in_scope.csv`.
- **Raw Excel-origin CSVs** (for the import view): `raw/orders_raw.csv`,
  `raw/vehicles_raw.csv`, `raw/routes_fact_raw.csv`.
- **Canonical (Nexus output)**: `input/orders.json`, `input/vehicles.json`,
  `input/orders.geojson`. Provenance via `source_sha256` + audit (Nexus).

### Units & conventions (critical)

- **Coordinates**: tabular fields are `lat, lon`; GeoJSON is `[lon, lat]` (RFC 7946).
  MapLibre/Velo want `[lon, lat]` / `lat,lon` respectively — convert explicitly.
- **Pallets**: explicit `double` (fractional, stackable) — never inferred from weight.
- **Demand is 2-D**: `[weight_kg, pallets]`; vehicle `capacity: [kg, pallets]`;
  `dimension_count = 2`, `demand_sign_convention = 1` (delivery positive).
- **Time**: Surge JSON is **seconds-from-midnight** (e.g. 18000 = 05:00). CSVs are
  `HH:MM` local (Hungary). Display as `HH:MM`.
- **Distance/duration**: Surge + matrix are **meters / seconds**. Show km / min.
- **Join key**: order `id` (e.g. `sample-258486-40758`, with `#n` suffix for
  repeats). Never join on `order_no` alone (not unique).

## Surge solution → Plan mapping

Surge solution schema (`surge/src/sg_api.c:1627`): `{ status, stats, routes[], unassigned[] }`.
`routes[]` = one object per used vehicle; `stops[]` carry `trip_index` (0-based
trip within the shift), `arrival`/`service_start`/`departure` (sec-from-midnight),
`request_id`, `task_id`, `type`. `trip_count` gives trips; reloads are implicit
between `trip_index` boundaries (`trip_reload_seconds`). `status` OK and LIMIT are
both usable plans; INFEASIBLE/ERROR are not.

Order/location metadata (customer, city, lon/lat, tw, pallets, weight, service)
is resolved from the **request** JSON (`locations[]` + `tasks[]`), keyed by
`task_id` → location. Vehicle `ref`/class/capacity from request `vehicles[]` by
`vehicle_id`.

### Plan (backend → frontend contract)

```jsonc
Plan {
  "id": "pln_...", "scenarioId": "scn_...", "scenarioRevision": 3,
  "day": "2026-05-06", "createdAt": "ISO8601", "source": "saved" | "live",
  "provenance": {
    "inputSha256": "…",              // hash of the exact request JSON solved
    "solverConfig": { seed, maxIterations, maxTimeSeconds, lexicographic, hardCapacity, hardTimeWindows, hardMaxDuration },
    "termination": "OK" | "LIMIT",   // Surge status
    "validation": { "valid": true, "violations": [ … ] }
  },
  "stats": {
    "servedOrders": 117, "totalOrders": 117,  // distinct orders delivered / in scope
    "deliveryStops": 117,                      // stop count (== served, delivery-only)
    "trips": 17, "vehiclesUsed": 11,
    "totalDistanceKm": 3860, "solveElapsedSeconds": 12.3
  },
  "depot": { "name": "Depot", "lon": 18.6441461, "lat": 47.6039649 },
  "vehicles": [ {
    "id": 1, "ref": "RIC-124", "class": "tractor_trailer", "color": "#2e7d5b",
    "capacityKg": 24000, "capacityPallets": 50,
    "tripCount": 3, "finishTimeSec": 61200,
    "peakKg": 23110, "peakPallets": 48,       // max load across trips (aggregate, NOT a 3L placement)
    "distanceKm": 420,
    "trips": [ {
      "index": 0, "startSec": 18000, "endSec": 29000, "distanceKm": 150, "reloadSecAfter": 1800,
      "stops": [ {
        "orderId": "sample-…", "orderNo": "258486", "customer": "…", "city": "…",
        "lon": 18.9, "lat": 47.4, "seq": 1,
        "type": "delivery", "arrivalSec": 18650, "serviceStartSec": 18650, "departureSec": 20450,
        "twStartSec": 18000, "twEndSec": 30600, "pallets": 12.5, "weightKg": 8400, "serviceMin": 30,
        "lateBySec": 0
      } ],
      "geometry": { "type": "LineString", "coordinates": [[lon,lat], …] }  // road-following, from Velo, cached
    } ]
  } ],
  "unassigned": [ { "orderId": "…", "orderNo": "…", "customer": "…", "reason": "…" } ]
}
```

Vehicle `color` is assigned by the backend from a fixed distinct palette, stable within a
plan, so list/map/timeline agree.

## Backend HTTP API (draft)

Meta: `GET /api/health` (reachability of surge/carta/velo/sage), `GET /api/config`.

Days & scenarios (base day is immutable; edits create a child scenario copy):
- `GET /api/days` → available planning days + counts.
- `POST /api/scenarios` `{ day, from?, edits? }` → create (base load, or a copy
  with edits like `{ removeVehicleId }`). Returns `{ id, revision, parentId? }`.
- `GET /api/scenarios/:id` → orders, vehicles, depot, provenance, edits.

Solve (jobs, off event loop):
- `POST /api/scenarios/:id/solve` → `{ jobId, scenarioRevision }`.
- `GET /api/jobs/:id` → `{ status, elapsedSec, scenarioRevision, planId?, error? }`
  (status ∈ pending|running|completed|failed|cancelled).
- `DELETE /api/jobs/:id` → cancel (kill child) where running.

Plans:
- `GET /api/scenarios/:id/plans` → plan summaries.
- `GET /api/plans/:id` → full Plan (above).
- `GET /api/compare?base=:planId&revised=:planId` → metric deltas, changed vehicle
  assignments, newly-unassigned orders.
- `GET /api/plans/:id/export?format=json|csv` → documented export.

Import / provenance (dedicated import view):
- `GET /api/import/raw?file=orders|vehicles|routes` → headers + sample rows of the
  raw Excel-origin CSV.
- `GET /api/import/reconcile` → Nexus reconcile report (canonical↔raw, mismatches),
  rules applied, reconciled counts/units.

Narration (Sage, optional, gated):
- `POST /api/plans/:id/narrate` / `POST /api/compare/narrate` → Hungarian summary.

Same-origin assets (so the reused Carta style's relative URLs + `transformRequest`
work unmodified):
- `GET /tiles.vector.json`, `GET /tiles/*` → proxied to Carta (`CARTA_ORIGIN`).
- `GET /fonts/*` → local SDF glyphs (Inter + IBM Plex), 404 on missing ranges.
- `GET /*` → static SPA (built `web/dist`), SPA fallback to `index.html`.

## Stale-job & revision safety

Every job and plan records `scenarioRevision`. The frontend ignores a job result
whose `scenarioRevision` ≠ the currently selected scenario revision, so a slow
older solve can never replace the active plan. The baseline plan is immutable;
replans always target a scenario copy.

## Pallet / Load view

The 3L loading-feasibility checker is **design-approved but not implemented**
(`docs/roadmaps/surge.md`). The Load tab therefore shows **aggregate scalar
capacity only** (weight and pallet utilization vs vehicle caps, per trip), and
states explicitly that physical loading feasibility has not been checked. No
per-pallet placement is drawn.
