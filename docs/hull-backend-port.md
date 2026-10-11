# Porting the Dispatch backend to Hull — exploration & plan

**Status:** exploration only (no code). Decision memo (a) + route-by-route
TS→QuickJS map and service contracts (b) + the two resolved unknowns (c).

**Constraints assumed** (set by the product owner):
1. App language = **QuickJS / ES2023** on Hull (not Lua).
2. The **Python scripts become Hull-internal** QuickJS components (or services).
3. **Surge / Velo / Carta run as separate API services** that Hull calls over HTTP.
4. The **React/Vite frontend is retained unchanged** (it only speaks the REST contract).

---

## 1. Summary / recommendation

A *straight* port (keep spawning `surge_solve` / `matrix_build` / Python) is
**impossible on Hull** — its capability sandbox forbids subprocess execution by
design. Under the four constraints above the blocker disappears and the port
becomes a **feasible, moderate re-platform of ~1–1.5 months**, dominated by
(i) rewriting the transport/plumbing to Hull idioms and (ii) the ingest/geocode
reimplementation. The ~1,170 LOC of pure domain logic and the entire frontend
are cheap because they stay in the JS family and behind a stable REST contract.

**Recommendation:** do it only if you actually want Hull's platform benefits
(single signed sandboxed binary, SQLite, durable job queue, and **built-in
auth/JWT/CORS/CSP/rate-limiting** — which closes the commercial-gate auth gap).
It is not worth doing for its own sake, and auth specifically is far cheaper to
add to the current Node backend. If pursued, use the **strangler plan** in §6
(run Hull beside Node, flip routes one at a time) and de-risk geocoding and the
Velo matrix endpoint first (§5).

Confidence: medium. The biggest residual unknowns are QuickJS stdlib
completeness (Intl/structuredClone) and solver/matrix latency over HTTP — both
checkable with the small experiments in §7.

---

## 2. Why Hull blocks the straight port, and what the constraints unblock

Hull is a capability-secure runtime: every effect (fs, net, env, exec) is
manifest-declared and kernel-enforced, and **arbitrary subprocess exec is not a
capability** (`os.execute`/`spawn` are unavailable; the only exec path is a
build-time compiler allowlist). The current Dispatch backend is, at its core, a
**subprocess orchestrator**: it spawns `surge_solve`, `matrix_build`, and the
Nexus/Python ingest + geocode tools and parses their stdout. That pattern has no
Hull equivalent.

The constraints remove every subprocess:
- Surge/Velo/Carta (and, we argue, **Nexus**) become **HTTP services** → Hull
  reaches them via its `net` capability (outbound HTTP is fully supported).
- The genuinely-Python bits (`sample_table.py`, `geocode_verify.py`,
  `normalize_address.py`) become **Hull-internal QuickJS** — except the Nexus C
  core (`nx_pipeline`) which is better exposed as a service than reimplemented.

Everything else Hull already does well and maturely: REST routing + JSON +
`hull/validate`, streaming multipart upload, SQLite + migrations, a durable
DB-backed **job queue** with retries/polling, timers, structured logging, and
the security middleware stack (auth/JWT, CORS, CSP, CSRF, rate-limit).

---

## 3. Target architecture

```
                         ┌───────────────────────────── Hull app (QuickJS, single binary) ─────────────┐
  React/Vite SPA  ──────▶│  static dist (embedded) + /* history fallback                                │
  (unchanged)            │  REST: /api/* (40 routes)   middleware: auth · cors · csp · ratelimit         │
                         │  store: SQLite (hull/db) + migrations      jobs: hull/jobs (durable)          │
                         │  geocode: QuickJS (normalizer + cache in SQLite)                              │
                         └───┬──────────────┬───────────────┬───────────────┬───────────────┬───────────┘
                             │ HTTP         │ HTTP          │ HTTP          │ HTTP          │ HTTP
                        ┌────▼───┐     ┌────▼────┐     ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
                        │ Surge  │     │ Velo    │     │ Nexus   │     │ Carta   │     │ Locus / │
                        │ /solve │     │ /route  │     │ /canon  │     │ /tiles  │     │ Sage /  │
                        │ (NEW   │     │ +/matrix│     │ (wrap   │     │ (exists)│     │ Google/ │
                        │  svc)  │     │ (NEW ep)│     │ nx_pipe)│     │         │     │ HERE    │
                        └────────┘     └─────────┘     └─────────┘     └─────────┘     └─────────┘
```

What already exists vs. what's new:
- **Velo** route server exists (`/api/v1/route`), **matrix endpoint is NEW** (§5.1).
- **Carta** tile API exists → Hull proxies `/tiles/*`.
- **Locus** geocoder service exists (:8083) → geocode cross-check.
- **Sage** LLM exists (:8084) → narration, already called over HTTP today.
- **Surge** has no server → **NEW** thin service wrapping `surge_solve`.
- **Nexus** core is a C binary (`nx_pipeline`) → **NEW** thin service wrapping it.

Operational trade: one Node process + CLI spawns becomes Hull + Surge-svc +
Velo-svc + Nexus-svc + Carta-svc. Hull itself is one sandboxed binary, but the
*system* now has more long-lived services to run and health-check (Velo/Carta
already are). This matches OTTO's transport-agnostic manifesto.

---

## 4. Effort estimate

| Area | Current LOC | Effort | Notes |
|------|-------------|--------|-------|
| Pure domain logic (`mapper`, `cost`, `evaluate`, `schedule`, `week`, `compare`, `export`, `types`, `classifyUnassigned`) | ~1,170 | **Low** | TS→JS near-verbatim; swap `createHash`→Hull crypto, `toLocale`→manual fmt |
| Routes + transport (`server.ts`) | 634 | Medium | 40 handlers → `app.*`; CORS/CSP/ratelimit/**auth** become Hull middleware |
| Store → SQLite (`hull/db`) | 516 | Medium | CRUD/GC → SQL + migrations (upgrade over JSON-file store) |
| Jobs (`solve.ts`) → `hull/jobs` | 280 | Medium | durable job calling Surge-svc over HTTP + mapping result |
| Ingest/geocode cluster (`onboard`,`admit`,`dataset`,`import`,`fleet`,`catalog`,`matrix`) | ~970 | **Medium–High** | geocode reimpl (libpostal-free, §5.2); Nexus→service; matrix→Velo HTTP |
| External clients (`velo`,`sage`) | 270 | Low | fetch → Hull `net` + timeout |
| Stand up **Surge-svc** + **Nexus-svc** + Velo matrix ep | — | Medium | thin Keel/HTTP wrappers around existing binaries |
| Frontend | — | Low (~1–2 d) | build `dist/` → Hull `static/` + `/*` fallback + `/tiles` proxy; **no app-code changes** |
| Re-author tests | ~1,620 | Medium | node:test → Hull test runner; Playwright-against-live still works (point at Hull) |

**Total: ~4–7 focused weeks** for one engineer fluent in both. Critical path is
the ingest/geocode cluster + standing up the two new services.

---

## 5. Resolved unknowns (c)

### 5.1 Velo matrix endpoint — ABSENT, must be added

Evidence: `velo/api/` (`velo-route-server`) exposes only `/api/v1/route`,
`/api/v1/health`, `/api/v1/stats` (`velo/api/test_api.sh`). The all-pairs matrix
the backend needs comes from the **`matrix_build` CLI**, not the server. Going
services-only therefore requires a **new endpoint** on the Velo API that wraps
the same `matrix_build` code path:

```
POST /api/v1/matrix
  body: { "profile": "truck", "weight": "duration",
          "locations": [ { "id": 0, "lat": 47.5, "lon": 19.0 }, ... ] }   // ≤ maxMatrixLocations
  200:  { "location_count": N,
          "durations": [ ... N*N, row-major, seconds ... ],
          "distances": [ ... N*N, row-major, metres ... ],
          "snap_warnings": [ { "index": i, "meters": m }, ... ] }
```
This mirrors exactly what `geometry/matrix.ts` parses today (the `M i j dur dist`
and `S idx node snap` lines), so Hull-side parsing becomes trivial JSON. Effort:
a modest C addition to `velo-route-server` (the matrix compute already exists).

### 5.2 libpostal-free geocode — feasible; the fallback already exists

Evidence: `nexus/scripts/geocode_verify.py` imports
`from normalize_address import expand, parse, looks_like_poi, HAVE_LIBPOSTAL` —
i.e. **libpostal is already optional** with a non-libpostal fallback branch.
Providers are **Google** (`google_geocode`, `google_components` with a
country+postal_code filter) and **HERE** (`here_geocode`) — both plain HTTP —
plus a file cache (`--cache-dir`), a GeoNames postcode envelope for RED
detection, and GREEN/YELLOW/APPROX/RED tiering. `GEOCODE_OFFLINE=1` forbids live
calls (cache-only, reproducible).

Proposed Hull-internal geocode (QuickJS), no libpostal:
- **Normalizer** (replaces libpostal `expand`/`parse`): a small HU-focused JS
  function — accent-fold, lowercase, expand street abbreviations (`u.`→`utca`,
  `krt`→`körút`, `út`/`tér`…), extract the 4-digit postcode and city by regex.
  This is the same job the Python fallback does when `HAVE_LIBPOSTAL` is false.
- **Primary geocoder:** Google Geocoding API over Hull `net` (it parses the
  address itself and returns structured components + confidence), using the
  `components=country:HU|postal_code:NNNN` filter to lift centroid/partial hits.
- **Cross-check:** Locus service (:8083, already exists) and/or HERE, to compute
  the provider-agreement distance that drives the tier.
- **Tiering:** keep GREEN/YELLOW/APPROX/RED from confidence + partial-match flag
  + inter-provider distance + GeoNames postcode envelope (ship the GeoNames
  table as data; the envelope check is pure arithmetic).
- **Cache:** SQLite table keyed by normalized address; only TERMINAL statuses
  cached (never cache transient/quota errors → no lost spend on re-run), exactly
  as today.

Accuracy note: dropping libpostal loses robust multilingual POI parsing, but for
HU-only addresses leaning on Google's own parsing + a targeted HU normalizer
matches the existing non-libpostal path. **De-risk by diffing tiers** on the
dataset: run libpostal-on vs libpostal-off today and confirm the tier
distribution is acceptable before committing (§7).

### 5.3 Bonus: Nexus is C, not Python

`nx_pipeline` is a Mach-O binary (C), and the reconcile/canonicalize gate lives
there, not in Python. So "rewrite the Python" only really covers
`sample_table.py` (CSV/XLSX sampling) + the geocode scripts. The Nexus core
should become a **service** (consistent with Surge/Velo/Carta) rather than be
reimplemented in QuickJS. Caveat: **XLSX parsing** (today via `sample_table.py`)
needs a zip+XML reader; prefer handing XLSX to the Nexus service too rather than
reimplementing an XLSX parser in QuickJS.

---

## 6. Route-by-route TS→QuickJS map (strangler-ordered)

All 40 routes keep their **path + method + JSON shape** (the frontend contract
is frozen). "Hull piece" is what each handler leans on.

| Route | Hull piece | Port notes |
|-------|-----------|------------|
| `GET /api/health` | — | trivial |
| `GET /api/config` | env | returns currency/source only (no secrets) |
| `GET /api/days` | db | list builtin + admitted days |
| `GET /api/week` | db + `week` logic | pure logic ports verbatim |
| `GET /api/sage/status` | net→Sage | HTTP health ping |
| `POST /api/scenarios` | db | create base/copy |
| `POST /api/scenarios/:id/edit` | db + `validate` | `validateScenarioEdit` → `hull/validate` schema |
| `POST /api/scenarios/:id/edits` | db + `validate` | batch; bound ≤1000 |
| `GET /api/scenarios` / `/:id` / `/:id/plans` | db | reads |
| `POST /api/scenarios/:id/rename` · `DELETE /:id` | db | base protected |
| `GET /api/scenarios/:id/export` · `POST /import` | db + `validate` | `parseScenarioImport` → schema |
| `GET /api/scenarios/:id/solve` | **jobs** + net→Surge | enqueue solve job (see §7 Surge contract) |
| `GET /api/jobs/:id` · `DELETE /:id` | jobs | `hull/jobs` status/cancel |
| `GET /api/plans` · `/:id` | db + net→Velo | `/:id` fills road geometry via Velo `/route` |
| `GET /api/plans/:id/export.csv` · `routesheet.html` · `routes.csv` · `handoff.json` | `export` logic | pure; `toLocale`→manual HU fmt |
| `GET /api/compare` · `POST narrate` · `POST compare/narrate` | `compare` + net→Sage | pure compare + HTTP to Sage |
| `GET /api/import/summary` · `raw` · `canonical` · `catalog` | db / net→Nexus | reads + sampling (Nexus `/sample`) |
| `POST /api/import/upload` | multipart + blob | Hull streaming multipart → content-addressed store |
| `POST /api/import/preview` | net→Nexus | canonicalize + reconcile gate (§7 Nexus contract) |
| `POST /api/import/geocode` | geocode (QuickJS) | §5.2 |
| `POST /api/import/admit` | **jobs** + net→Velo matrix + db | geocode→matrix→request→register (durable job) |
| `GET /api/import/datasets` · `DELETE /:id` | db + fs | registry in SQLite; dataset dir on fs (path-guarded) |
| `GET /tiles.vector.json` · `GET /tiles/*` | net→Carta | reverse-proxy to Carta tile API |

**Transport specifics that change shape (not contract):**
- Fastify typed routes → `app.get/post(path, (req,res)=>…)`; body via
  `json.decode(req.body)` + `hull/validate`; `reply.code(n).send(x)` →
  `res:status(n):json(x)`; headers via `res:header(...)`.
- `onRequest` security-headers/CORS + `ratelimit.ts` → Hull middleware
  (`app.use("*","/api/*", …)`), **plus a real auth middleware** (today's gap).
- `@fastify/static` SPA + `@fastify/multipart` → Hull `static/` embed + streaming
  `req:multipart()`.

---

## 7. Service contracts (new/changed)

**Surge-svc (NEW — wrap `surge_solve`).** `surge_solve` today reads a request
JSON file and writes a solution JSON. Thin server:
```
POST /api/v1/solve        body: <SurgeRequest JSON>   →  200 <SurgeSolution JSON>
     (long solves: either block with a server-side timeout, or return 202 + a
      job id with GET /api/v1/solve/:id; Hull wraps whichever in a hull/job so
      the existing /api/scenarios/:id/solve → /api/jobs/:id polling UX is kept.)
GET  /api/v1/health · /stats
```
Hull's `solve.ts` equivalent: build the request (apply pins/forbids/sequences),
POST it, map `SurgeSolution`→`Plan` with the (ported) `mapper`, persist.

**Velo matrix endpoint (NEW on existing Velo svc).** See §5.1.

**Nexus-svc (NEW — wrap `nx_pipeline`).**
```
POST /api/v1/sample       body: {fileRef, limit}      → {headers[], rows[][], totalRows}   (CSV + XLSX)
POST /api/v1/canonical    body: {fileRef, schema}      → {canonical:{rows[],count}, reconcile:{rowsReconciled,mismatches,fieldsVerified[],mismatchSamples[]}, semantic:{…}}
GET  /api/v1/health
```
Replaces `sample_table.py` + `nx_pipeline`/`ingest` subprocess calls in
`onboard.ts`/`admit.ts`. XLSX handled here (avoids an XLSX parser in QuickJS).

**Carta tiles (exists).** Hull proxies `GET /tiles/*` and `/tiles.vector.json`.

**Already HTTP, unchanged:** Velo `/route`, Locus geocode (:8083), Sage
`/v1/chat/completions` (:8084), Google/HERE geocoding APIs.

**Strangler migration plan**
1. Stand up Hull serving ONLY `GET /api/health`,`/config`,`/days`,`/plans/:id`
   (read-only) backed by a SQLite import of the current JSON store. Point a dev
   copy of the frontend's `api` base at Hull for just those paths; everything
   else still hits Node. Validates routing, store, static embed, tiles proxy.
2. Add Surge-svc + the Velo matrix endpoint; migrate the **solve** + **admit**
   job routes. Validates jobs + service HTTP + solve latency.
3. Migrate the ingest/geocode routes (Nexus-svc + QuickJS geocode).
4. Migrate the remaining reads/edits/exports; add the **auth** middleware.
5. Cut the frontend's `api` base fully to Hull; retire Node.
Because the engines are services and the REST contract is frozen, each step is
independently shippable and reversible (flip the base back).

---

## 8. Risks & de-risking experiments

| Risk | Severity | De-risk before committing |
|------|----------|---------------------------|
| **QuickJS stdlib gaps** — `Intl`/`toLocaleString` (HU currency/number fmt in `export.ts`), `structuredClone` (`solve.ts`), `Date` nuances | Medium | In a scratch Hull app, format one HUF value + deep-clone a request; if `Intl` is stubbed, write a tiny HU `format.js` (trivial) |
| **Geocode accuracy without libpostal** | Medium | Diff GREEN/YELLOW/APPROX/RED tier counts libpostal-on vs -off on the dataset today |
| **Solve/matrix over HTTP** — latency + payload size (N² matrix for ~260 locations is MBs) + long solves | Medium | Prototype Surge-svc + Velo `/matrix`; time an end-to-end solve and a 260-loc matrix round-trip |
| **Operational**: 4–5 services vs 1 process; health/supervision | Low–Med | `hull deploy` + systemd/compose; Velo/Carta already run as services |
| **XLSX parsing** in QuickJS | Low | Route XLSX through Nexus-svc `/sample`, don't parse in Hull |
| **Pre-1.0 Hull** (v0.14) | Low–Med | Pin a version; the REST+DB+jobs surface is the mature part |

**Not a risk:** the frontend. It changes zero application code — only its `api`
base URL — so the port cannot regress the UI as long as each ported route
preserves its JSON shape (lock this with the existing Playwright suite pointed
at Hull).

---

## 9. Verdict

Feasible under the stated constraints; ~1–1.5 months; no frontend rewrite. Worth
it **iff** the Hull platform benefits (sandbox, single-binary, SQLite, durable
jobs, built-in auth) are the actual goal. If the near-term driver is only auth,
add it to the Node backend first (days, not weeks) and revisit Hull as a
deliberate re-platform later, starting with the §7 strangler step 1 and the §8
experiments.

---

## 10. "First-class engine" variant — engines as in-process WASM workers

The §3 baseline runs Surge/Velo/Nexus/Carta/Locus as separate HTTP services that
Hull calls over `net`. The more *idiomatic and impressive* Hull variant makes
them **in-process WASM compute workers** so the whole system is one signed,
capability-sandboxed binary. This is Hull's crown-jewel feature, not a hack.

Note on terminology: "sidekick"/sidecar is **not** a Hull concept (zero repo
hits), and Hull has **no native-process supervisor**. So there are exactly two
ways to reach an engine: out-of-process (`net`) or **in-process WASM worker**
(`compute.call`). There is no managed-native-child in between.

### 10.1 The mechanism (evidence)
- `compute.call(name, input, {gas})` sync + `compute.async.call(...)` on the
  host thread pool (`--workers N`); persistent instances (`compute.instance()`);
  AOT via `wamrc` for near-native speed; Memory64 for >4 GiB
  (`docs/wamr_architecture.md`, `examples/compute/`).
- **Mapped spans / data segments** (`hull_span.h`, `hull_segment_addr/size`,
  `docs/wasm_mapped_spans_design.md`): feed large *read-only* data (the Velo
  graph, Carta pbf, Locus index) into a worker **zero-copy**, host-side mmap
  mapped into the worker's linear memory. This answers the "a no-I/O worker
  can't load its index" objection.
- Framing caveat: Hull pitches WASM compute as *"gas-metered, no-I/O WASM
  isolation for user-supplied transforms/scoring/UDFs"* (`README.md:261`) — i.e.
  small bounded UDFs. Large trusted engines are swimming slightly upstream:
  per-call **gas** is caller-set (`examples/compute/app.lua` uses 1e6; raise for
  trusted modules) but metering taxes hot loops, and the worker gets **no files,
  sockets, env, or time**.

### 10.2 Cost that is NOT in the §4 estimate
Each engine needs a **new WASM target compiled against Hull's compute ABI**
(`hull_compute.h` host-calls + span I/O) — distinct from the existing
**emscripten/browser** WASM builds (`surge/wasm`, `velo/wasm`, …). The C core is
reused; the entrypoint/build is new per engine, and the engine must take all
input as args/spans (no file/env/socket/time). That is ~5 mini-ports **in the
OTTO C repos**, on top of the backend rewrite.

### 10.3 Per-engine fit
| Engine | Compute profile | Big data? | WASM-worker fit | Notes |
|--------|-----------------|-----------|-----------------|-------|
| **Locus** | cheap queries | index (trie/ngram/spatial) as span | **Great** | best first port — low stakes, proves the ABI/span/AOT toolchain |
| **Nexus** canonicalize/reconcile | pure compute over uploaded rows | small | **Great** | XLSX parse must move in-module (zip/xml) or stay on a Nexus service |
| **Surge** solve | heavy ALNS | small (request JSON) | **Conditional** | §11 — gas/perf is the pivotal unknown; portfolio-parallel ⇒ host fan-out, not in-wasm threads |
| **Velo** matrix | heavy (N× Dijkstra) | **large** graph span | **Conditional** | gas + big span + N²·260 output; add a matrix endpoint either way (§5.1) |
| **Carta** tiles | moderate per tile | large pbf span | **Low value** | tiles are fine as the existing Carta API; least worth forcing in-process |

**Likely honest end-state: a hybrid** — Locus + Nexus in-process WASM workers
(idiomatic, single-binary); Surge/Velo as workers *iff* §11/§5 spikes pass, else
co-deployed services; Carta stays a service. A handler calls `compute.call`
where a worker exists and `net` where it is still a service — same shape either
way, so the split can change over time without touching routes.

---

## 11. Spike — "how fast is Surge in WASM?" (the pivotal, do-it-first experiment)

### 11.1 Reframe: you probably do NOT need a multi-threaded WASM build
Surge's parallelism is **portfolio / multi-start**, not fine-grained shared
memory: `sg_parallel.h` — *"multiple independent runs with different seeds …
the best solution is retained"*; each worker **clones** the context and shares
only a read-only params pointer + an atomic cancel flag (`surge/src/sg_parallel.c`).
So there are two ways to parallelize Surge in WASM:

- **(A) In-module threads** — a `-pthread` / wasm-threads Surge WASM (shared
  memory + atomics). In the browser this needs COOP/COEP + Web Workers; in Hull
  it needs WAMR built with the **threads proposal**, which is **not evidenced**
  in Hull's build (confirm in `docs/wamr_architecture.md`; the host `-lpthread`
  is the host pool, not in-wasm threads). Harder, less portable.
- **(B) Host fan-out of single-threaded instances** — run **K single-threaded
  Surge WASM instances concurrently** (browser: K Web Workers; Hull:
  `compute.async.call × K` on `--workers K`), each seed = base+i, then reduce to
  the best (unassigned → vehicles → distance). **This reproduces
  `sg_solve_parallel` exactly** and needs no wasm-threads, no shared memory —
  and it is precisely Hull's concurrency model.

**Conclusion: measure (B) first.** (A) is only worth it for single-call latency
on one core, which portfolio does not need. The existing single-threaded
`surge/wasm` build is already the per-instance unit for (B).

### 11.2 The metric that actually decides it
Multi-start improves **solution quality for a fixed wall-clock budget**, not
latency. WASM runs each instance ~1.5–3× slower than native, so in the same
budget each WASM worker explores fewer iterations. The go/no-go question is
therefore:

> For the product's solve budget T (≈15–30 s) and K = cores, is the **solution
> quality** of *K concurrent single-threaded WASM Surge runs* within an
> acceptable gap of *native `sg_solve_parallel(K)`* on real dataset days?

Quality = lexicographic (unassigned, vehicles_used, total_distance_km) vs the
committed baselines (day1 = 0 unassigned / known vehicles+km).

### 11.3 Method (standalone first — no Hull needed)
1. **Baseline:** native `surge_solve` / `sg_solve_parallel(K)` on day1 (and a
   larger day), budget T, record quality + iterations/run. Already runnable.
2. **Per-instance WASM speed:** run the existing single-threaded `surge/wasm`
   build on the same request, budget T, same seed; record iterations achieved
   and quality. Compute the **WASM slowdown factor** = native-iters / wasm-iters
   at equal wall-clock (single run).
3. **Portfolio in WASM:** run **K** single-threaded WASM instances concurrently
   (simplest harness: K OS processes via a WASI runtime — wasmtime/wasmer — or
   Node `worker_threads`, each loading the module), seeds base..base+K-1, budget
   T, reduce to best. Record quality vs step 1.
4. **(Optional, only if step 3 is borderline) measure (A):** add `-pthread`
   (emscripten `-sUSE_PTHREADS -sPTHREAD_POOL_SIZE=K`, shared memory; note
   `ALLOW_MEMORY_GROWTH` + shared-memory caveats) and benchmark one K-thread
   solve vs step 3's K-instance fan-out, to see if in-module threads buy
   anything over host fan-out.

### 11.4 Go / no-go thresholds (tune to taste)
- **GO (Surge as in-process WASM worker):** portfolio-WASM quality gap vs native
  ≤ ~1–2% distance (and never worse on unassigned/vehicles) at budget T, with
  per-instance slowdown ≤ ~3×. ⇒ ship Surge as a `compute.async.call × K` worker.
- **MARGINAL:** acceptable only at a larger budget, or needs (A). ⇒ keep Surge a
  **service** but still single-binary-deploy the rest; revisit with AOT tuning.
- **NO-GO:** quality gap large or slowdown > ~4–5×. ⇒ Surge stays a service;
  Locus/Nexus still become workers (the hybrid remains a credible Hull showcase).

### 11.5 Hull-integration follow-on (after a GO)
- Recompile Surge's C against `hull_compute.h` (request JSON in via a span/arg,
  solution JSON out via a span), AOT with `wamrc`.
- Hull `solve.ts` equivalent: build request → `compute.async.call` K instances
  with seed+i under a `hull/job` → reduce to best → map→Plan → persist. Keep the
  existing `/scenarios/:id/solve` → `/jobs/:id` polling UX.
- Confirm gas sizing for budget T (raise per-call gas; verify no cap is hit) and
  that cancel maps to the job's cancel.

### 11.6 What this spike yields regardless of outcome
A measured answer to "can OTTO's solver live inside a Hull WASM worker," the
per-instance WASM slowdown number (reusable for Velo/Carta sizing), and
first-hand experience of the compute ABI + AOT + async fan-out — i.e. the Hull
fluency that motivated the exercise, bought cheaply and before any big commit.
