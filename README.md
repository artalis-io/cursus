# Cursus

A polished dispatch-planning workspace over a sample logistics dataset: load a
planning day, optimize deliveries with **Surge**, inspect vehicle trips, apply
manual overrides, replan, and compare plans — on a **Carta** basemap with
**Velo** road geometry. One desktop workspace; precision-industrial styling.

Dispatcher workflow features:

- **Manual overrides (human-in-the-loop):** pin an order to a vehicle, move it
  to another, or forbid a vehicle for it; the solver respects these on the next
  replan (Surge `allowed_vehicles` / `forbidden_vehicles`). Overrides accumulate
  on an editable scenario copy; the baseline is never mutated.
- **Cost in forint:** every plan carries an estimated operating cost under a
  carrier tariff, shown as a KPI and in the before/after comparison. Two tariff
  models: `per_vehicle` (fixed + per-km, the illustrative demo) and `per_trip`
  (base + per round-trip km + per-drop surcharge, own-fleet vs subcontractor
  multiplier) — the real rate card shape. Uses `${DATASET_ROOT}/rates/tariff.json`
  when present (a `per_trip` tariff regressed from the real TS/BHS carrier rate
  card lands the two-day optimized plan at ~6.0M HUF, matching the known figure),
  else the demo tariff. The tariff file is confidential and never committed.
- **Solve controls:** choose the objective (fewest vehicles vs least distance)
  and the time budget; cancel a running solve; a solve survives a page reload
  (the job runs server-side and the UI reconnects to it).
- **Operational exports:** printable per-vehicle driver route sheets (stops,
  ETAs, windows, loads, nav links), a flat stops CSV, and the plan JSON.

This is a complete transportation-planning and dispatch application. It reuses
the vendored OTTO engines (optimization stays in C/Surge, geometry in C/Velo,
tiles in C/Carta) behind a thin Node/TS backend (`server`) and a React frontend
(`web`). The current TypeScript application architecture is intentionally kept
intact; the planned Hull/Keel migration has not been started.

The UI is bilingual (**English / Hungarian**, toggle in the top bar, persisted
locally). An optional **Sage** narration (DGX Spark LLM, `SAGE_ORIGIN`) summarizes
a plan or a comparison in the current language, built only from the plan's own
figures; it is on-demand and degrades gracefully when the LLM endpoint is down.

## Layout

Before releasing the stateful runtime, run the [production-image acceptance
suite and release gate](docs/release-acceptance.md). It tests two authenticated
replicas sharing PostgreSQL and S3-compatible storage, with native Surge solves;
an optional external Gyermelyi check exercises the conversion pipeline.

| Path | What |
|------|------|
| `server` | Node/TS app backend: scenarios, plans, solve jobs (via `surge_solve`), road geometry (via Velo), provenance, Carta tile proxy, static SPA serving. |
| `web` | React + TypeScript + Vite + Tailwind + shadcn/ui + react-map-gl + motion frontend. |
| `docs/data-api-mapping.md` | The data + API contract and the Surge-solution → Plan mapping. |
| `vendor/otto` | Pinned OTTO engine source (submodule). Future Hull and Keel dependencies belong beside it under `vendor/`; they are not part of this migration. |

## Services & ports

| Service | Port | Start |
|---|---|---|
| Carta (vector tiles, Hungary) | 8097 | `./vendor/otto/carta/api/carta-tile-server -p 8097 vendor/otto/data/index/hungary-carta.idx` |
| Velo (road geometry, truck) | 8082 | `VELO_RATE_LIMIT_ENABLED=0 ./vendor/otto/velo/api/velo-route-server vendor/otto/data/index/hungary-velo.vlg` |
| Cursus backend | 8091 | `cd server && npm run dev` |
| Cursus web (dev) | 5179 | `cd web && npm run dev` |
| Surge | — | invoked as the `surge/surge_solve` CLI by the backend |

> Velo rate-limiting must be **off** for bulk geometry precompute (it caps at
> 10 rps by default). The backend precomputes each plan's road geometry once and
> caches it (in memory + on disk); it is never fetched per selection change.

## Prerequisites

- Initialized and built vendored OTTO binaries: `vendor/otto/surge/surge_solve`,
  `vendor/otto/carta/api/carta-tile-server`, `vendor/otto/velo/api/velo-route-server`
  (`git submodule update --init --recursive`, then build within `vendor/otto`).
- Dataset indexes under `vendor/otto/data/index/` (or override their paths with
  the environment variables below).
- The immutable customer dataset at `DATASET_ROOT`
  (default `/Users/mark/artalis.io/data/dataset`) — never committed.
- Node 20 (the repo has nvm: `nvm use 20`).

## Run (development)

```bash
# 1. tiles + geometry (from the Cursus repo root)
./vendor/otto/carta/api/carta-tile-server -p 8097 vendor/otto/data/index/hungary-carta.idx &
VELO_RATE_LIMIT_ENABLED=0 ./vendor/otto/velo/api/velo-route-server vendor/otto/data/index/hungary-velo.vlg &

# 2. backend (serves /api, proxies /tiles to Carta, runs surge_solve)
#    DATASET_ROOT must point at your (uncommitted) dataset; it has no client-named default.
cd server && npm install
DATASET_ROOT=~/path/to/your/dataset npm run dev         # :8091

# 3. frontend (proxies /api and /tiles to the backend)
cd web && npm install
VITE_API_ORIGIN=http://127.0.0.1:8091 npm run dev       # :5179 -> open this
```

Day 1 (2026-05-06) loads with its real saved baseline plan. Click **Optimize**
to re-solve live, select a vehicle to coordinate the map/timeline/inspector,
**Mark unavailable & replan** to solve a reduced fleet, then **Compare**.

## Run (production: backend serves the built SPA)

```bash
cd web && npm run build                    # -> web/dist
cd ../server && npm run build              # tsc -> dist (or use npm start/tsx)
# the backend serves web/dist same-origin; open http://localhost:8091
npm start
```

## Run with Docker Compose

The production Compose deployment builds Cursus, Surge, Velo, Carta, Locus and
the OSM conversion tools locally from source. Customer data and geographic
assets remain external bind mounts. Only Cursus is exposed, on
`127.0.0.1:8091` by default; the native services use a private network. See
[`deploy/README.md`](deploy/README.md) for security, preparation, backup,
upgrade and troubleshooting details.
The adopted Cloudflare load-balancer/tunnel topology and read-only HA tooling
are documented in [`docs/deployment-ha.md`](docs/deployment-ha.md).
The persistence, background-work, consistency, and rolling-deployment design is
documented in [`docs/stateful-deployment.md`](docs/stateful-deployment.md).
The pre-deployment PostgreSQL/R2 primitives and local concurrency tests are in
[`docs/stateful-infrastructure.md`](docs/stateful-infrastructure.md).
That document also records the merged stateful runtime adapters and native
Surge fencing tests. Tenant-isolation findings, workspace identity, authorization
boundaries and the proposed tenant switcher are in
[`docs/tenant-isolation-and-switching.md`](docs/tenant-isolation-and-switching.md).
The separately approved production provision, migration,
write-freeze, origin-draining cutover, and rollback procedure is documented in
[`docs/production-cutover.md`](docs/production-cutover.md). PostgreSQL recovery
remains manual and fail-closed; application routing HA is not a claim of
automatic database HA or a hard asynchronous-replication RPO.

The stateful PostgreSQL/R2 runtime is the accepted production system of record.
The legacy writer remains frozen pending separately approved cleanup; its
snapshots and backups are recovery evidence, not an automatic rollback target.
Production application rollback must preserve all post-cutover PostgreSQL
writes.

```bash
git submodule update --init --recursive
cp .env.example .env
# Set CURSUS_DATASET_PATH, CURSUS_DATA_PATH and OSM_DATA_PATH to existing
# host directories and paths to external allowlist/Resend-key files. Do not put
# private data in this checkout.
docker compose config --quiet
docker compose build
docker compose --profile prepare --profile geocoding build osm-prepare locus
docker compose --profile prepare run --rm osm-prepare
docker compose up -d --no-build
docker compose ps
./deploy/smoke.sh
```

`osm-prepare` reuses an existing `OSM_PBF_FILE` without network access, or
downloads `OSM_PBF_URL` when it is absent. It explicitly creates and validates
versioned Velo, Carta and Locus indexes before publishing them atomically.
Normal startup never performs geographic conversion. To stop the services
without deleting external state or indexes, run `docker compose down`.

### Verified local Hungary/Gyermelyi deployment

On 2026-10-11 this stack was built and exercised natively on an Apple ARM64
host using Docker Engine 20.10.17, Compose 2.7.0 and an 8 GB Docker VM. The
private Gyermelyi dataset was mounted read-only, application state was mounted
separately, and the existing 294 MiB Hungary Geofabrik PBF was reused offline.
Hungary preparation completed in 436 seconds and produced a Velo graph with
2,722,834 nodes/5,480,054 edges and a Carta index with 4,964,814 features.

The frontend, API, Carta proxy and all container health checks passed. A real
day-one, 240-second Surge solve completed in 240.827 seconds with truthful
`LIMIT` status (115/117 orders, 10 vehicles, 3,700 km); the authoritative saved
baseline remained 117/117 orders, 11 vehicles and 3,860 km. Restarting Cursus
preserved the generated plan. Steady post-solve memory was approximately 118
MiB for Cursus, 5.52 GiB for Velo and 1.09 GiB for Carta. These measurements are
host/workload observations, not configured resource limits.

A cold full-country geometry pass needs additional transient Velo query memory.
The current 7.7 GiB local Docker limit can run the idle services but can OOM
Velo while Carta is resident. Allocate at least 10 GiB to Docker for a cold
Hungary browser acceptance run. On a smaller developer VM, stop Carta, request
both baseline plans once to populate the external geometry cache, then restart
Carta before Playwright. This is a developer-machine workaround only; the
128 GiB Sparks run the complete stack concurrently.

Compose 2.7 does not support `docker compose up --pull never`; use the
documented `--no-build` command after building. Newer Compose versions may add
`--pull never` when an explicit registry-pull guard is desired. All application
services have deterministic local image names and require no application image
registry.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `DISPATCH_PORT` | 8091 | Backend port. |
| `CURSUS_PUBLIC_ORIGIN` | `https://cursus.artalis.io` | Canonical origin used in magic links and CSRF checks. |
| `CURSUS_AUTH_ALLOWLIST_PATH` | required by Compose | External file containing approved emails, one per line; never commit it. |
| `RESEND_API_KEY_PATH` | required by Compose | External file containing the Resend API key; never commit it. |
| `CURSUS_AUTH_FROM` | `Cursus <login@cursus.artalis.io>` | Verified Resend sender; no inbox is required. |
| `OTTO_ROOT` | `<cursus>/vendor/otto` | Where the built binaries + indexes live. |
| `DATASET_ROOT` | `…/data/dataset` | Immutable dataset (read-only). |
| `CARTA_ORIGIN` / `VELO_ORIGIN` | `127.0.0.1:8097` / `:8082` | Upstreams. |
| `SAGE_ORIGIN` | `127.0.0.1:8084` | Optional LLM narration (Spark). |
| `DISPATCH_SOLVE_SECONDS` | 240 | Default solve budget. |
| `DISPATCH_ANONYMIZE` | 0 | `1` pseudonymizes customer names (cities/coords kept) for shippable screenshots. |
| `DISPATCH_MAX_CONCURRENT_SOLVES` | 2 | Max `surge_solve` processes at once; the rest queue (jobs stay `pending`). |
| `DISPATCH_SOLVE_GRACE_SEC` | 20 | A solve overrunning its budget by this much is hard-killed (SIGTERM→SIGKILL). |
| `DISPATCH_MAX_SOLVE_OUTPUT_MB` | 128 | Cap on captured solver stdout; beyond it the job fails instead of OOMing. |
| `DISPATCH_RETAIN_PLANS` / `_JOBS` | 200 / 200 | Retention: oldest persisted plans/jobs (and their request files) are pruned. |
| `DISPATCH_RATE_RPS` / `_BURST` | 40 / 120 | Per-IP API rate limit (token bucket); `/tiles` and `/api/health` are exempt. |
| `DISPATCH_UPLOADS_DIR` | `${DATASET_ROOT}/uploads` | Where uploaded datasets land (external, never committed). |
| `DISPATCH_RAW_ORDERS` / `_VEHICLES` / `_ROUTES` | `raw/orders_raw.csv` / `raw/vehicles_raw.csv` / `raw/routes_fact_raw.csv` | Raw source CSV paths (relative to `DATASET_ROOT`) for the import-provenance view; point at your dataset's actual filenames if they carry a client prefix. |
| `NEXUS_DIR` | `${OTTO_ROOT}/nexus` | Nexus engines (`ingest.sh`, `reconcile.py`, `nx_pipeline`) for onboarding. |
| `DISPATCH_MAX_UPLOAD_MB` / `_ROWS` | 25 / 50000 | Upload size / row caps. |
| `GEOCODE_CACHE_DIR` | `${DATASET_ROOT}/.geocode_cache` | Geocode cache (reused; known addresses are free). |
| `GEOCODE_PBF` / `GEOCODE_ENV` | `${OTTO_ROOT}/data/…pbf` / `${OTTO_ROOT}/.env` | OSM PBF for the Locus cross-check; `.env` with API keys. |
| `DISPATCH_GEOCODE_OFFLINE` | 0 | `1` forces cache-only geocoding even when keys exist. |
| `MATRIX_BUILD_BIN` / `VELO_GRAPH` | `${OTTO_ROOT}/velo/matrix_build` / `…/data/index/hungary-velo.vlg` | All-pairs travel-matrix builder + graph (admitting a dataset; `make -C velo tools`). |
| `DISPATCH_MAX_MATRIX_LOCATIONS` | 1500 | Cap on an uploaded dataset's routable locations (matrix is N²). |
| `rates/tariff.json` | (demo) | Optional real carrier tariff under `DATASET_ROOT` (uncommitted). Absent → an illustrative demo tariff drives the cost KPI, labelled as such. |
| `VITE_API_ORIGIN` | `localhost:8091` | Frontend → backend origin (dev proxy). |
| `VITE_SOLVE_SECONDS` | 60 | UI-triggered solve budget. |

## Tests & screenshots

- Backend unit tests: `cd server && npm test` (result mapping,
  comparison incl. cost, scenario edits + stale-job association, override
  application, cost tariff, CSV/route-sheet export, week roll-up, edit
  validation/bounds, rate limiter).
- UI tests (Playwright, real browser against the running app): with the stack up
  (backend + Carta + Velo) and the web app on :5179 (or set `VIEWER_URL`), run
  `cd web && npm run test:ui`. Covers load/KPIs/cost, i18n, inspector
  vehicle→trip→stop navigation, the staged edit stack + a full Replan, week view,
  constraint advisories, playback and solve settings. Uses the cached Chromium
  (`PW_CHROMIUM`) with software WebGL.
  `app.spec.ts` is also the release regression for the real two-day dataset: it
  requires Day 1 and Day 2 and rejects any trip without road geometry. Run it
  against the locally built image before deployment with
  `VIEWER_URL=http://127.0.0.1:18080 npm run test:ui -- app.spec.ts`.
- Screenshots (real browser via Playwright, cached Chromium):
  `cd web && PW_CHROMIUM=… node scripts/shot.mjs` (and `shot-replan`,
  `shot-import`, `shot-stage4`). Committed screenshots are captured with
  `DISPATCH_ANONYMIZE=1`.

## Scope & limitations

- Two real planning days (2026-05-06, 2026-05-07), solved independently.
- The **3L loading checker is not implemented** (design-only), so the Load tab
  shows aggregate scalar capacity only and states feasibility is unchecked.
- The saved per-day baselines are authoritative real Surge results; a clean
  day-1 117/0 solve needs the full ~240s budget (shorter budgets report their
  honest LIMIT status and may leave orders unassigned).
- Cost is an **estimate** under a tariff (demo tariff unless a real rate card is
  provided); it is not invoicing. Carrier management, driver apps, POD and ERP
  sync are out of scope.

The isolated two-node stateful staging, replication, backup/restore and fenced
promotion contract is documented in
[`docs/stateful-deployment-infrastructure.md`](docs/stateful-deployment-infrastructure.md).
It uses `compose.stateful.yaml` and `deploy/stateful.py`; it does not replace the
production port-8080 services or mutate Cloudflare. The documented staging run
uses a read-only external customer dataset mount, separately mounted Hungary
OSM assets, a dedicated R2 bucket, and the same immutable ARM64 application
image on both Sparks; it completed native conversion and Surge solve workflows
through both replicas.
