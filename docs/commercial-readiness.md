# Cursus: hardening findings + commercial-grade design

> Migration note (October 2026): this assessment predates the move from
> `otto/dispatch` to the standalone Cursus repository. Historical path and CI
> references below describe the source layout at the time of the review.

Status: assessment and plan (no code changed). Produced from a four-dimension
read-only audit (backend security, durability/scale, frontend robustness,
productization/ops), with the serious findings spot-verified against the code.

## TL;DR

Dispatch is an unusually well-built *internal demo*: bounded solve jobs with a
watchdog, atomic JSON persistence with corruption quarantine, a per-IP rate
limiter, retention GC, a clean error envelope that never leaks stacks, parser
isolation (raw bytes only ever parsed in the Python Role-P subprocess), 49
backend unit tests + 15 Playwright specs. Subprocess calls are injection-safe
(execFile with arg arrays, fixed binary paths) and path traversal is controlled
(regex-gated ids, server-generated upload names).

It is demo-grade on the two axes that matter most for SaaS: **there is no
authentication and no tenant model**. It is also single-process by construction
(in-memory job queue + in-memory store maps), has developer absolute paths as
config defaults, and has no production deploy path, metrics, or audit trail.

Two work tracks follow: a **hardening punch-list** (fixable now, within the
current single-node architecture) and a **commercial-grade design** (the
architectural lifts), phased.

---

## Part A: Hardening punch-list (in-scope now)

> Status: **all of A1-A15 shipped** on `the dispatch feature branch` as six
> focused commits (durability; admission control + backpressure; security quick
> wins; config validation; frontend robustness; CI gate). A13 needed no change
> (bounded by nx_xlsx's existing 50 MB/entry cap).

Ordered by value. Each is achievable without introducing a database, auth
provider, or multi-node infra, so each can ship as a focused PR against the
current design. Severity reflects a real deployment, not the demo.

### A1. Reconcile stranded jobs on restart  [CRITICAL, tiny]
`store.ts` constructor runs `gcPlans()`/`gcJobs()` but never reconciles jobs
persisted as `running`/`pending`. Verified: after any restart those jobs stay
`running` forever and the UI polls them indefinitely (applies to both solve and
import jobs, `solve.ts:135`, `server.ts:374`). Fix: on boot, sweep
`running`/`pending` jobs to `failed` with `error:'interrupted by restart'` and
`finishedAt=now`. Smallest high-impact fix here.

### A2. Admission control across all CPU-heavy subprocesses  [High]
Only solves are capped (`maxConcurrentSolves`). `POST /api/import/admit` spawns
geocode (64 MB buffer) + `matrix_build` (512 MB buffer) + holds an N^2 matrix,
with no cap on concurrent admits (`server.ts:368`, `matrix.ts:27`). A handful of
simultaneous uploads can OOM the single process. Fix: one shared semaphore
sized to cores, covering solve + geocode + matrix; 503 when saturated.

### A3. Bounded solve queue with backpressure  [High]
`solve.ts:20` queue is an unbounded array; every `POST /solve` returns 202 and
pushes, each also writing a job file and a `_request.json` that embeds the
matrix. A script can enqueue thousands. Fix: cap queue depth (e.g.
`maxConcurrent x K`), return 503 when full.

### A4. Frontend: abort the admit poll and dialog fetches on unmount  [High]
`OnboardPanel.doAdmit` calls `pollJob(jobId, ...)` with **no AbortSignal**
(verified, I wrote it); closing the dialog leaves a ~1 min poll running and
calling `setState` on an unmounted tree. Every dialog (`CompareDialog`,
`ImportDialog`, `WeekDialog`, `HistoryDialog`, `NarrationPanel`, `OnboardPanel`)
does `api.x().then(setState)` in an effect with no cleanup, so a slow response
can resolve after close or a later request (last-write-wins race, worst in
`ImportDialog`'s raw-file switch). Fix: AbortController (or an `alive` flag) in
each effect and in `doAdmit`, mirroring the solve path in `App.tsx:145`.

### A5. Security quick wins (no auth infra needed)  [Medium]
- Register `@fastify/helmet` (CSP, nosniff, frame-deny, HSTS) and an explicit
  default-deny CORS policy; neither is present today.
- Rate-limit and shape-validate the Carta tile proxy (`server.ts:407`): it is
  currently an unauthenticated, rate-limit-exempt relay to an internal service.
- Pass an explicit env allowlist to the geocoder child instead of spreading the
  full `process.env` (`admit.ts:70`, `onboard.ts:247`).
- Couple bind address to safety: refuse to listen on a non-loopback host unless
  auth is configured (`config.ts:22`). (Full auth is Part B.)

### A6. Humanize HTTP errors; stop swallowing refresh failures  [Medium]
`jget`/`jsend` throw `"/api/...: 429"` verbatim; a rate-limited dispatcher sees
that raw string. `onboardDatasets`/`onDatasetsChanged` catch and silently set
`[]`, so a failed list looks identical to "no datasets". Fix: map 429/5xx/network
to localized messages (add EN/HU keys), surface non-fatal refresh failures as a
toast/inline note. Also add a small bounded retry in `pollJob` so one dropped
tick does not abort a healthy server-side solve.

### A7. Guard destructive actions during an active solve  [Medium]
Deleting a dataset whose day is currently solving silently kills the running
optimization (no confirm). The per-stop assignment `<select>` and constraint
inputs in `Inspector.tsx` are not `disabled` while `solving` (the buttons are),
so an edit can be staged mid-solve and drift the scenario revision. Fix:
confirm-before-delete when the dataset owns the solving day; disable those
inputs while solving.

### A8. Atomic + bounded writes everywhere  [Medium]
`registry.ts:45` (`dataset.json`) and the geocache (`velo.ts:33`) use plain
`writeFileSync`; a crash mid-write corrupts them (the geocache then silently
drops the whole cache on next load). The store already has an atomic
temp+rename `writeJson`. Fix: extract it to a shared util and route both through
it; bound the geocache (LRU) so it stops being an unbounded full-file rewrite.

### A9. Transactional dataset admit + orphan sweep  [Medium]
`admitDataset` creates the dataset dir and writes `request.json` before
`registerDataset` writes the manifest (`admit.ts:56,123,139`). A hard crash in
between orphans a manifest-less dir that is never cleaned or shown. Fix: write
`dataset.json` last (atomic), and sweep dirs lacking a valid manifest on boot.

### A10. Lower or stream subprocess buffers  [Medium]
`maxSolveOutputMB=128` and the matrix `maxBuffer=512 MB` are each read fully into
the Node heap (the matrix as one string, then split). Concurrent jobs multiply
this. Fix: stream `matrix_build` output to a temp file / parse incrementally, and
lower the solve default. Pairs with A2.

### A11. Config fail-fast (remove developer path defaults)  [Medium]
`config.ts:25,28` default `ottoRoot`/`datasetRoot` to `/Users/mark/...`, fanned
out across ~10 derived paths. On any other machine every default is wrong, and
it fails late and cryptically. Fix: no absolute-path defaults; fail fast on
unset required config with a message that names the variable (matches the
monorepo CLAUDE.md convention).

### A12. Share, don't clone, the N^2 matrix  [Low/perf]
`buildRequest` does `structuredClone(day.request)` per solve (`solve.ts:35`),
deep-cloning the 2.25M-entry matrix each time (blocking allocation). Fix: clone
only the mutated parts (vehicles/tasks/requests); share the matrix by reference.

### A13. XLSX workbook-total decompression cap  [Low]
Correction to the audit: `nx_xlsx.c:32` already caps each ZIP entry at 50 MB, so
a single-entry zip bomb is bounded. Residual risk is a workbook with many large
entries. Fix (defense in depth): add a total-decompressed ceiling in the parser.

### A14. Fix the reopenPlan staleness guard  [Low]
`App.tsx:253` compares `baseline?.day` (an id like `day1`) to `d.isoDate` (an ISO
date); never equal, so the guard is always true (harmless today, latent). Fix:
compare id to id (`baseline?.day !== d.id`).

### A15. CI gate for dispatch  [High, process]
Dispatch is absent from OTTO CI. Add a job on PRs touching `dispatch/`:
`tsc --noEmit` (server + web) + `npm test`, and the headless Playwright run
(now that `playwright.config.ts` auto-resolves the cached browser). Cheap, and
it locks in everything above.

---

## Part B: commercial-grade design (architectural)

Phased so each phase is independently shippable and ordered by what unblocks the
next. Nothing in Part B should start before the Part A items it depends on; A1,
A4, A11, A15 in particular are prerequisites for taking any of this live.

### Phase 1: Trust and tenancy  (the gate; nothing else matters until this lands)
- **Authentication**: identity via OIDC/SSO (or signed bearer tokens for
  API clients). A global Fastify `onRequest` hook rejects unauthenticated
  requests before any handler. Tie it to the bind address (A5).
- **Authorization**: per-route ownership checks on every `:id` (plans,
  scenarios, jobs, datasets). Today any caller can read/delete any resource.
- **Tenant model**: a `tenant` (org) threaded through every store key, the
  uploads dir, the registry, the geocode cache, and all ids. Retire the
  hardcoded `DAYS` and the hard-coded depot (`dataset.ts:22,173`) in favour of
  per-tenant datasets; the upload/admit path already proves the pattern, the
  built-ins are the anomaly. Depot comes from dataset config, not a literal.
- **Secrets**: inject geocoding keys as env/vault values, not by regex-grepping
  a cross-repo `.env` (`onboard.ts:222`). Validate the tariff schema on load.
- **Audit trail**: append-only log of dispatcher actions (pin/forbid/remove/
  replan) tied to user identity. Baseline for a decision tool.

### Phase 2: Persistence and scale  (remove the single-process assumption)
- **Real datastore**: SQLite to start (single node), Postgres for multi-node.
  Replaces loading the whole store into memory, the O(n) boot, the
  all-plans-resident OOM risk, and the linear list scans; gives transactions and
  optimistic concurrency (an `If-Match: revision` precondition on scenario edits,
  fixing the lost-update path on concurrent edits).
- **Durable, bounded job queue**: persisted and reconciled (A1 becomes native),
  with backpressure (A3). External (Redis/BullMQ) once multi-node.
- **Statelessness**: job state, rate-limit tokens (Redis), and dataset/plan
  storage out of the process so N replicas behind a load balancer share one
  source of truth. Until then, enforce single-instance with a data-dir pid lock.
- Carry over A2/A8/A10/A12 (admission control, atomic writes, streaming,
  share-not-clone) as the DB-backed versions.

### Phase 3: Operations and deployment
- **Compiled run path**: `node dist/server.js` (today `npm start` runs tsx on
  source); `NODE_ENV=production`; graceful SIGTERM that drains the solve queue
  and signals children.
- **Containerization**: a Dockerfile for server and web and a compose/k8s
  manifest wiring dispatch to Velo/Carta/Surge (today only the C engines have
  Dockerfiles). Serve the SPA from a CDN/static host, or keep same-origin but
  fix the `@fastify/static wildcard:false` stale-SPA restart gotcha
  (`server.ts:426`) with a deploy that restarts on rebuild.
- **Observability**: `/readyz` gating on upstream + dataset health (the code
  already knows via `veloReachable()`, `server.ts:75`); Prometheus/OTel metrics
  for request latency, solve duration, queue depth, upstream health; error
  tracking (Sentry-class); structured logs with request-id correlation.
- **Tests**: HTTP integration tests injecting into the Fastify app (auth, authz,
  rate limit, multipart, error envelope, proxy); load tests of the solve
  queue/watchdog/output-cap paths. Extends A15.

### Phase 4: Data lifecycle and compliance
- Retention + right-to-erasure for uploaded **raw and geocoded PII**, not just
  derived plans. Note: dataset DELETE already `rmSync`es the dataset dir
  (verified, registry.ts:54); the gaps are the raw upload left in `uploads/tmp/`
  and the shared `.geocode_cache`.
- Per-tenant geocode cache (today a shared dir is a cross-tenant leak vector).
- Configurable third-party geocoding opt-out per tenant (today a single global
  offline flag); a DPA/data-residency posture; real pseudonymization at rest
  (today `DISPATCH_ANONYMIZE` is a display-only, off-by-default screenshot
  filter that keeps cities and exact coordinates).

### Phase 5: Product completeness (demo-grade to production-grade logic)
The optimization itself is production-grade (real Surge, hard constraints, pins/
forbids, per-vehicle overrides, two objectives). The surrounding model is
demo-grade:
- **Pricing**: multi-carrier, versioned, zone-based tariff with schema
  validation, replacing the single-carrier `DEMO_TARIFF`/regressed card. State
  clearly that cost is estimation, not invoicing.
- **Feasibility**: implement the 3L loading checker (design-only today; capacity
  is aggregate weight/pallets, stacking/access unverified).
- **Legality**: HoS / driver-legality integration (the planned Hose engine).
- **Scale**: push the onboarding matrix past the 1500-location cap (hybrid reuse
  of the known cache is the deferred lever); geocoding/graph coverage beyond
  Hungary.
- **Onboarding runtime**: self-contained/containerized engines + indexes, plus a
  tenant-provisioning flow (admin UI, per-customer config/tariff/dataset), so
  onboarding a customer is not "build the C engines and set env vars".

---

## Suggested sequencing

1. **Now (safe, in-scope):** A1, A4, A15 first (tiny, high-value, lock-in), then
   A2/A3/A5/A6/A7/A8/A9, then the A10-A14 polish. All ship against today's
   architecture.
2. **Commercial MVP gate:** Phase 1 (auth + tenancy + secrets + audit). Non-
   negotiable before any external exposure.
3. **Scale + ops:** Phase 2 then Phase 3.
4. **Compliance + product depth:** Phase 4 and Phase 5, driven by the first real
   customer's contract requirements.
