# Opt-in axle-load enforcement

Cursus supports OTTO loading V2's `rigid_two_axle_v1` model alongside existing
V1 stacking. OTTO is pinned to `25a518835e864c589c104012a8e32dd127a9a1d8`.
This implementation does not deploy or activate production enforcement.

## Facts and policy

The prepared-bundle import accepts physical metadata with `schemaVersion: 2`,
`mode: disabled`, the original dataset request SHA-256, and
`requiredCapabilities: ["stacking", "axle_loads"]`. Other capabilities, including
reshuffling, are rejected. V1 documents retain their original shape and behavior.

V2 retains the existing vehicle and unit fields, adding:

- Vehicle `axles`: `model`, `profileSha256`, `wheelbaseMm`, `footprintLengthMm`,
  `deckMinMm`, `deckMaxMm`, `slotCentresMm`, `frontTareG`, `rearTareG`,
  `frontLimitsG`, `rearLimitsG`, `maxGrossG`, `minFrontFraction`.
- Each request: `deliveryTaskId`, checked against the original stable task ID.
- Each unit: `cgOffsetMm: {min, max}`.

Masses are integer grams, coordinates integer millimetres relative to the front
axle. Tare/limit intervals use `{min, max}`; the optional front fraction is
explicitly `null` or `{numerator, denominator}`. Profile SHA-256 identifies the
calibration record; its presence does not authenticate a measurement. The first
model supports two individual rigid axles, not tandem/tridem groups or trailers.
There is no temporary unloading or reshuffling.

All declarations must cover the complete original input inventory. Slot positions,
rear access, footprints, signed CG bounds and supported numeric ranges are checked
before admission. Axle gross limits cannot exceed a known positive fleet GVW;
changed approved fleet settings are rechecked before solving. Zero limits restrict
feasibility, never mean unlimited. No tare, CG, geometry, legal rule, or exemption
is inferred from net weights, pallet equivalents or existing Gyermelyi routes.

`CURSUS_HARD_LOADING_ENABLED=0` remains the default. Importing facts never enables
enforcement. With policy enabled, dataset admission stores a source-bound
`loadingRequirement` in PostgreSQL's immutable manifest; solve admission copies it
into the durable job. It cannot be downgraded by a browser request. Sources and
scenarios already latched by hard-mode publication remain required if the flag is
later disabled. Existing source references are not migrated or overwritten.

## Worker and publication boundaries

Hard-enabled runtime startup requires actual native V2 capability discovery before
readiness. V2 solves also probe the executable under a timeout/output bound and
verify required capabilities, model and limits. The actual executable is hashed
before execution and after completion, as in V1. No version-string inference,
HTTP solver service or replacement optimizer is introduced; HGS settings stay
unchanged. The certificate retains the discovery response and required capabilities.

Sparse request, vehicle and task IDs are compacted once and restored consistently
in placements, operations, stop schedules and unassigned diagnostics. Source
metadata remains immutable, separate from disposable native workspaces.

Independent JavaScript BigInt replay verifies every empty/depot loading/unloading
state, exact rational reaction extrema, gross mass, front-load fraction, payload,
stack support, access, unit inventory and complete stop schedule. Reaction numerators
stay decimal strings across JSON and export. Replay never searches for a different
witness and never runs a native process or accesses R2 under a database lock.

Publication rereads source requirements and validates the certificate inside the
existing scenario/lease transaction. Only the current unexpired fencing generation
can insert the plan. A worker returning V1 evidence for a V2 source, an obsolete
capability image, stale source/revision, malformed proof or UNKNOWN cannot publish.
The same checks govern selection, review, approval and Approved exports.

Manual reorder/assignment/exclusion remains available, but creates an unverified
draft and discards the old certificate. Replan must establish a new proof. Ordinary
draft exports remain available with their blockers. The Constraints panel shows
axle status in EN/HU and waits for the authoritative workflow check before saying
Verified; an empty assigned fleet does not receive that label.

## Verification and rollout

Use only disposable PostgreSQL/S3 integration resources and public synthetic facts:

```sh
make -C vendor/otto/surge surge_solve
CURSUS_TEST_SURGE_BIN="$PWD/vendor/otto/surge/surge_solve" npm --prefix server run test:ci
# With the documented disposable integration environment configured:
npm --prefix server run test:stateful
python3 deploy/acceptance.py --hard-loading --report /external/evidence/axles-on.json
python3 deploy/acceptance.py --report /external/evidence/axles-off.json
```

The two-replica integration covers real native V1 and V2 work, lease takeover,
corrupt/stale/downgraded publication, source binding, peer retrieval, approval,
export and manual invalidation. Production-image Playwright acceptance repeats
admission/solve/manual/replan/export for V1 and V2 under both policy settings.
No private fixtures are required or embedded.

Before any customer activation, all replicas and workers must use the same reviewed
image/policy, verified physical measurements must be supplied, and representative
real loads must pass independent checks. Older application/native versions that
ignore required capabilities are unsupported rollback targets. Keep authoritative
PostgreSQL writes and R2 objects; image rollback is not database rollback.

Measured customer calibration, production deployment/activation, articulated axle
models, reshuffling and database HA changes are outside this milestone.
