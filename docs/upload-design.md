# Cursus — Data onboarding (upload) design

Status: design (approved decisions below; not yet implemented).

## Goal

Bring-your-own-data onboarding. A dispatcher uploads a raw dataset (orders +
vehicles + historical routes, any CSV/XLSX), maps its columns to OTTO's canonical
fields, and the backend runs the **real** Nexus pipeline — reconcile gate,
semantic checks, geocoding, travel matrix, Surge request — behind a reviewed
dry-run. On admit it becomes a new dataset that yields selectable planning days.

No raw bytes are parsed in Node; the Python pipeline subprocess does that
(process isolation = OTTO's Role P). The reconcile gate is the trust boundary.

## Approved decisions

| Axis | Decision |
|------|----------|
| Scope | **Full re-ingest**: orders + vehicles + routes-fact (the whole canonical pipeline → a dataset → N days by delivery_date) |
| New addresses | **Hybrid**: reuse geocode cache + matrix for known locations; geocode + extend the Velo matrix only for genuinely new ones |
| Geocoding | **Keys if present, else offline**: Google/HERE when `GEOCODE_ENV` has keys; else Locus (local HU OSM) + GeoNames postcode centroids + cache |
| Input format | **Column mapping**: arbitrary CSV/XLSX; the user maps columns → canonical fields (new-customer onboarding, not a fixed schema) |

## Reuses the real pipeline (already on disk)

Generic engines (repo, dataset-agnostic, arg-driven): `nexus/scripts/`
`ingest.sh`, `reconcile.py`, `semantic_checks.py`, `normalize_address.py`,
`geocode_verify.py`. See `DATASET_ROOT/PIPELINE.md`. The geocoder caches
Google/HERE and supports `GEOCODE_OFFLINE=1` (cache-only, no billing). Matrix +
request builders: `build_surge_perday.py`, `matrices/`. The dispatch backend
drives these as subprocesses, exactly as it shells `surge_solve`.

## User flow

```
Upload files ─▶ Map columns ─▶ Validate (dry-run) ─▶ Geocode ─▶ Build ─▶ Admit ─▶ Days appear
                                   │ reconcile gate (HARD)        │ matrix + request
                                   │ semantic (advisory)          │
                                   └─ reject on gate failure      └─ only for NEW locations
```

1. **Upload** (Import view → "New dataset"): drop orders/vehicles/routes files.
   Stored in an external uploads dir with a generated name; size + MIME allowlist;
   no path traversal from the client filename.
2. **Map columns**: backend returns detected headers + sample rows per file; the
   UI shows a mapping table (header → canonical-field dropdown) with auto-suggested
   matches and required/type hints. Saved as a per-dataset schema (equivalent to
   `schemas/<entity>-v1.json`).
3. **Validate (dry-run)**: `ingest.sh` per entity → `reconcile.py` (HARD: every
   canonical field must trace to the raw bytes) + `semantic_checks.py` (advisory).
   Preview shows canonical records, reconcile pass/fail, semantic warnings,
   rejected rows. **No dataset created yet.**
4. **Geocode**: cache-first per normalized address. Known → cache hit (free).
   New → online (keys) or offline (Locus/GeoNames). Preview shows tiers
   (GREEN/YELLOW/APPROX/RED) on a mini-map + an all-points envelope check.
5. **Build**: travel matrix — reuse `matrices/` + cache where both endpoints are
   known; call the Velo table API only for new O-D pairs (capped). Then build the
   per-day Surge requests (size-guarantee dims + small-van subs, per
   `build_surge_perday.py`).
6. **Admit** (enabled only if the reconcile gate passed): persist the dataset +
   its days to the registry; they appear in the day selector.

## Architecture

New backend modules (`server/src`):
- `data/upload.ts` — multipart intake, storage, limits.
- `data/schema.ts` — canonical field catalog + mapping → dataset schema.
- `data/pipeline.ts` — a job runner mirroring `solve.ts` (concurrency cap,
  watchdog, bounded output, temp cleanup) that stages ingest → geocode → matrix →
  request, reporting sub-stage progress.
- `geometry/matrix.ts` — incremental Velo table for new locations; merges with
  cached/known matrix.
- `data/registry.ts` — dynamic datasets + days (`DAYS` becomes built-ins + registry).

Shared:
- `Job` gains `kind: 'solve' | 'import'` and a `stage` string so the existing job
  polling / cancel / progress UI works unchanged.
- `@fastify/multipart` (or raw) for upload.
- Persistence: `${DISPATCH_UPLOADS_DIR}` (default `${DATASET_ROOT}/uploads`),
  one folder per dataset: `raw/ schema.json canonical/ orders.geocoded.json
  matrices/ requests/`. **Never committed** (customer data). A `registry.json`
  lists datasets + their days.

Canonical field catalog (for the mapping UI), from the existing canonical shapes:
- orders: `order_no, customer, country, zip, city, street, delivery_date,
  weight_kg, pallets(double), tw_start, tw_end, service_min, special_req,
  requires_tail_lift`
- vehicles: `id, plate, vehicle_type, vehicle_class, depot, capacity_kg,
  capacity_pallets, gross_weight_kg, special_req, requires_tail_lift,
  is_subcontractor, operator`
- routes_fact: `order_no, vehicle, sequence, …` (historical, for the factual baseline)

## Security & trust

- **Untrusted file**: size cap, extension/MIME allowlist (csv/xlsx), random
  server-side filename, stored outside the web root.
- **Parser isolation**: Nexus + geocode run in the Python subprocess (Role P);
  Node never parses raw bytes.
- **Admit boundary**: the reconcile gate must pass (provenance sha + every field
  traces to raw) before a dataset can be admitted — validate-before-admit.
- **Resource limits** (reuse the hardened job infra): watchdog + concurrency cap;
  row-count cap; geocode request cap; matrix size cap (N² guard); online geocode
  only when keys are configured.
- **Data hygiene**: raw + derived data stay in the external uploads dir, never
  committed; the anonymization flag still governs display.

## Milestones (sequenced; each is a shippable PR)

- **M1 — Intake + mapping + reconcile preview. ✅ DONE.** Upload CSV, column-mapping
  UI (auto-suggest from headers), the real `ingest.sh` (nx_pipeline + reconcile
  HARD gate + semantic advisory) as a bounded subprocess, dry-run preview
  (reconcile pass/fail + canonical sample + semantic chips), reject on gate
  failure. No external calls. Backend: `data/catalog.ts`, `data/onboard.ts`,
  `scripts/sample_table.py`; routes `/api/import/{catalog,upload,preview}`.
  Frontend: `OnboardPanel` as an "Upload" tab in the data dialog. Uploads land in
  the external uploads dir. Tests: 6 unit + 1 UI.
- **M2 — Geocoding. ✅ DONE.** After the gate passes, derive `address_geocode` (a
  street/zip/city merge added to the schema) and run the real 3-way
  `geocode_verify.py` cache-first (online only when `.env` has keys, else
  `GEOCODE_OFFLINE`; reuses the dataset geocode cache + pbf). Preview shows mode,
  resolved/unresolved, tier counts (GREEN/YELLOW/APPROX/RED) and the points on a
  MapLibre mini-map coloured by tier. Route `/api/import/geocode`; `runGeocode` in
  onboard.ts. On the real data: 332/332 resolved from cache in ~0.6s. +2 unit, +1
  UI test.
- **M3 — Matrix + request + admit. ✅ DONE.** Admit geocodes, builds the travel
  matrix (`velo/matrix_build`, all-pairs Dijkstra over routable Hungarian orders),
  builds a Surge request in Node (locations/tasks/requests/travel + the known
  fleet, 0-indexed ids, split by delivery_date), and registers the dataset. Days
  become selectable alongside the built-ins via a dynamic `allDayIds()` + a
  registry; `loadDay` serves an uploaded day's request with an empty baseline and
  display enrichment from the geocoded orders. Verified: upload → admit (263
  routable, 2 days) → select → Optimize → real plan (8 veh, 115/117, 3100 km).
  `data/admit.ts`, `data/registry.ts`, `geometry/matrix.ts`; route
  `/api/import/admit`; +3 unit tests. *Deferred to M4:* the time-window regex
  transform (uploaded days get wide windows for now), hybrid matrix reuse of the
  known cache (full rebuild for now, ~1 min), solve-on-admit / background admit,
  and custom-fleet from an uploaded vehicles file (uses the known fleet for now).
- **M4 — Polish. (partial)** ✅ Time-window transform (uploaded orders get real
  windows from an "HH:MM - HH:MM" column via a regex split; 235/263 real on the
  real data). ✅ Dataset management (GET/DELETE `/api/import/datasets`; a list +
  delete in the Upload tab; removing a dataset drops its days/baselines and the
  app falls back if the current day vanishes). ✅ Background admit: admit now runs
  as a job (store `kind:'import'`), returns a jobId immediately, and the UI polls
  for the stage (geocoding → building travel matrix → building request →
  registering) instead of a frozen ~66s request. ✅ **XLSX input**: uploads accept
  `.xlsx` as well as CSV (the real `nx_pipeline` parses both natively, so ingest /
  reconcile / geocode are format-agnostic); `sampleUpload` branches to
  `nx_pipeline --raw` for headers+rows (Node never parses the bytes — the XLSX
  parse stays in the Role-P subprocess); `uploadPath` resolves an upload by its
  `id_entity.*` prefix whatever the extension. Verified end-to-end on the real
  orders as XLSX: upload (332 rows) → reconcile gate PASS (0 mismatches, 18 fields)
  → geocode 332/332 → admit (262 routable, 2 days). ✅ **Custom fleet from an
  uploaded vehicles file**: the admit step has an optional "Custom fleet" picker
  (CSV/XLSX, mapped the same way: Vehicle id + capacity kg/pallets). When present,
  `buildFleetFromUpload` ingests it through the real nx_pipeline and `toSurgeFleet`
  maps the canonical vehicles to a 0-indexed single-depot Surge fleet (a row that
  omits a capacity dimension falls back to a standard truck and is counted so the
  UI can warn); that fleet replaces the built-in template in the request, fail-fast
  before the matrix. `admitDataset(..., fleetSource?)`; `POST /api/import/admit`
  gains `vehiclesUploadId` + `vehiclesMapping`. Verified live: 38 vehicles from the
  real fleet file flow into the admitted request (`fleet {count:38, custom:true}`).
  *Remaining:* re-map + re-run (largely covered — the mapping stays editable and
  re-running Validate/Geocode uses it), hybrid matrix reuse (much less pressing now
  that admit is backgrounded).

## Risks / open items

- **Matrix cost**: N² for new locations; needs a cap + async + progress; very large
  uploads may be rejected or chunked.
- **Geocoding quality without keys**: Locus is HU-biased and postcode-level for some;
  surface tiers and require review of RED/APPROX before admit.
- **Schema mis-mapping**: reconcile catches transform errors, not semantic
  mis-maps; the semantic checks + preview mitigate; consider a confirm step on
  low-confidence auto-maps.
- **Carried data-quality realities**: multi-country zips, fractional pallets,
  shared tractors (documented in PIPELINE.md) — the mapping/validation must not
  reject these.
- **API keys**: `.env` via `GEOCODE_ENV`, never committed; absence → offline path.
