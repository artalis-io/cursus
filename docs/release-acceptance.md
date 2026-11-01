# Production-image acceptance and release gate

Before an application release, test the **exact locally built image** in the
stateful runtime. The legacy development server remains useful for UI work;
its browser tests alone cannot certify a stateful release.

## Run locally

Docker Engine/Compose, Python 3, Node.js and the web package dependencies must
already be available. Initialize OTTO with `git submodule update --init --recursive`.
No production credentials, R2 bucket, SSH access, Cloudflare token or customer
dataset is needed. Public base images are pulled; application images are built
locally and never published.

```bash
npm --prefix web ci
cd web && npx playwright install chromium && cd ..
python3 deploy/acceptance.py --report /tmp/cursus-acceptance/report.json
```

To certify an existing local release image (recommended before deployment):

```bash
python3 deploy/acceptance.py --image cursus-app:REVISION \
  --report /secure/release-evidence/REVISION.json
```

Build with the standard Dockerfile and full `CURSUS_REVISION` and `OTTO_REVISION`
build arguments. The report binds its result to the immutable image ID, source
labels, architecture, native executable checksums, migration versions and test
harness checksum. Both replicas must run that exact image. ARM64 and AMD64
images need separate reports; source equivalence does not imply digest equality.
CPU compatibility also matters within an architecture: the current OTTO
toolchain uses `-march=native` for Velo. A matrix executable built on DGX Spark
can execute unsupported instructions on an M1 despite both reporting ARM64.
Run full candidate-image acceptance on a compatible deployment CPU, or certify
a separately built baseline-portable image. Browser-only success cannot certify
the matrix executable. A failed private workflow always keeps the report failed.

The runner creates a random Compose project, four dynamically selected loopback
ports, disposable PostgreSQL and S3-compatible storage, test-only credentials,
and two replicas of the production image. It uses the real entrypoint, enables
magic-link authentication, disables provider delivery and never reads `.env`.
The browser obtains its link from the isolated transactional outbox and follows
the real GET/confirmation-form POST flow. Successful workflow checks use the real
HTTP handlers, shared persistence and native executables. Layout and failure-path tests can supply long lists,
hold requests or inject malformed/error responses in the browser; those injections
do not replace the native end-to-end checks. The immediate-click test holds and
releases a real edit request to expose races.

Temporary files and services are removed on completion or handled interruption;
the locally built image is retained. Concurrent runs use separate ports,
projects, databases, buckets, credentials and browser-artifact directories.
A missing prerequisite or a port conflict fails the run instead of changing
another deployment. The fixture refuses to seed a nonempty database and never
truncates existing tables.

## What must pass

- Anonymous APIs reject access, allowed login works, sessions work across
  replicas, cross-origin writes fail, and foreign tenant IDs cannot be read or exported.
- Two planning days load from admitted immutable objects, without a legacy dataset.
- Reordering produces an actual recomputed preview; native Replan obeys the new order.
- Excluding a vehicle removes its stable ID and preserves service on the known-feasible fixture.
- Locking a route preserves its vehicle and exact order.
- Immediate Optimize/Replan waits for the persisted edit and solves its exact revision.
- Every fixture order appears exactly once, authoritative counts reconcile,
  native feasibility passes, capacities/time windows hold and vehicle IDs remain stable.
- Plans are retrieved through the other replica and JSON exports agree with
  the same immutable plan's orders, counts and costs.
- Application restart retains sessions, plans and exports while the peer stays ready.
- History, week overview, checksum layout and upload mapping render from real
  stateful responses; unvalidated uploads remain invisible to solvers.
- The account bar displays the authenticated email, local initials and role,
  alongside the version and source revision baked into the running image. It
  reserves space below the workspace at desktop and narrow mobile widths.
  Sign out revokes the session across both replicas; a simulated failed logout
  keeps the workspace open with a retryable error, rather than pretending success.
  The header shows the backend-provided workspace name as a read-only label,
  including translated labeling, bounded mobile layout and refresh/logout behavior.
  Long and missing display-name edge cases are simulated by changing only that
  field in an otherwise real authenticated response; no switching is enabled.

The acceptance tests run without retries. Any failure, flaky result or skipped
test blocks acceptance. CI builds the production image on Linux AMD64 and runs
this suite alongside the existing unit, concurrency and fencing tests. The
aggregate **release** check requires every job to succeed. Repository branch
protection should require `release`; this change does not edit GitHub protection settings.

The public fixture deliberately includes sparse vehicle/request IDs and
interleaved planning days. Its checks reject the older pre-PR-21 image at fixture
validation, before it can receive a passing report.

## Enforced deployment gate

The current suite contains 104 checks. Its browser command has a 20-minute aggregate budget, with 25 minutes for the CI job including image preparation. Individual browser tests retain their 120-second limit, assertions, and zero-retry policy; skips and flaky results still block acceptance.

Use a clean checkout for release evidence. Development runs record a dirty
checkout, but the deployment gate rejects such reports. A stale passing report
is replaced with `running`/`failed` when a retry starts; failure cannot leave
the previous success eligible for deployment.

```bash
python3 deploy/stateful.py rollout --image cursus-app:REVISION \
  --acceptance-report /secure/release-evidence/REVISION.json --approve
python3 deploy/stateful.py rollback --image cursus-app:PREVIOUS_REVISION \
  --acceptance-report /secure/release-evidence/PREVIOUS_REVISION.json --approve
```

Rollout checks evidence against both nodes' image IDs before changing either
application. It uses the immutable image ID for Compose, preserving secondary-first
ordering and schema compatibility checks. Rollout reports must be at most 24
hours old, and the controller checkout must match the tested harness checksum.
A rollback can reuse the previous release's older passing report;
it still requires the exact image and supported schema. Keep release images and
their evidence together. When the harness changes, recertify the rollback image
with the new harness before approving a release. Reports are operator-controlled records, not signed
attestations or protection against a malicious operator.

Initial production activation also requires `--acceptance-report` in addition to
its existing gates. Production activation still needs explicit approval and
the existing origin-draining procedure. This suite does not deploy to Sparks,
change Cloudflare, restore databases or alter the legacy write freeze.

## Optional external Gyermelyi pipeline acceptance

For releases touching ingestion, mapping, matrices, solver requests or costs,
also run the private workflow. Keep its JSON configuration **outside every source
checkout**, with absolute paths to existing inputs:

```json
{
  "datasetRoot": "/external/customer",
  "orders": "/external/customer/raw/orders.csv",
  "pbf": "/external/osm/region.osm.pbf",
  "graph": "/external/osm/region.vlg",
  "geocodeCache": "/external/customer/geocode-cache",
  "sourceName": "orders.csv",
  "mapping": {
    "order_no": 0, "customer": 4, "zip": 5, "city": 6, "street": 7,
    "delivery_date": 9, "weight_kg": 11, "pallets": 12,
    "time_window_raw": 13, "service_min": 14
  },
  "minimumServedFraction": 0.95,
  "solveSeconds": 30
}
```

Adapt column mappings to the actual source. CSV/XLSX input is accepted by the
native pipeline; set `sourceName` to the correct extension. The dataset root
must include the current legacy template dependencies (`input` and
`results/perday/day1_*`), and the PBF/graph/cache must be compatible and already
prepared. This operation does not prepare country-wide indexes.

```bash
python3 deploy/acceptance.py --image cursus-app:REVISION \
  --gyermelyi-config /external/private-acceptance.json \
  --report /secure/release-evidence/REVISION-gyermelyi.json
```

After public browser acceptance, this extra job runs Nexus, offline geocoding,
Velo matrix generation, checksum-addressed object upload, expired-lease takeover,
fenced admission, native Surge optimization, cross-instance API retrieval and
consistent export. Customer inputs and geographic files are mounted read-only
only for that job; its geocode cache is copied into disposable container scratch.
It uses a separate test tenant and the disposable S3 store, never production R2
or PostgreSQL. It does not put private data in the image, repository, build
context or browser traces. Reports contain counts, timing and checksums, and raw
private errors are suppressed. The configured served-fraction threshold is an
explicit quality check for that workload; it is not a universal feasibility rule.

## Limits and next increments

The default suite verifies application state, authentication and real solver
execution. It deliberately does **not** certify Carta tiles, Velo HTTP geometry,
country-scale performance, real Resend delivery, database failover, backup/PITR
recovery or every possible optimization edit. Its unused graph-path sentinel
satisfies the image dependency preflight only; reports explicitly say geographic
services were not verified. Use the existing external geographic acceptance
checks for map changes and the recovery drills for database changes.

Add one focused regression for each new production defect. Keep dependency
upgrades, schema changes and behavior changes in separate reviews. A passing
small fixture proves its invariants; larger workload quality and failure recovery
need their own recorded evidence.
