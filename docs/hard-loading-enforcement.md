# Opt-in hard loading

This adds stateful-runtime enforcement, without activating it for production or
Gyermelyi. No physical facts are inferred. It uses OTTO's existing loading model
and HGS solver; witness replay is not another packing/search engine.

## Activation boundary

`CURSUS_HARD_LOADING_ENABLED=0` is the default in every deployment example.
Only `0` and `1` are accepted; `1` requires `CURSUS_RUNTIME_MODE=stateful`.
The opt-in policy applies to admitted datasets with verified `physicalLoading`
facts. Datasets without physical declarations retain their existing behavior,
unless a scenario already requires loading. Import still requires metadata
`mode: disabled`: clients cannot enable or disable runtime enforcement by
uploading a document or embedding native `loading` in the solver request.

Both replicas and all workers must first run the same loading-aware image and
matching configuration. Queue admission records the runtime policy; another
replica with a different policy refuses the job. Activation is a separate,
explicitly reviewed deployment operation, not part of this implementation.

A committed hard-mode plan/draft latches its immutable physical source through
the existing tenant-scoped plan ledger. Native completion also records
`scenario.hardLoadingRequired`; copies and edits preserve it. Turning the flag
off does not erase an already-required source or scenario. Missing facts on
such a scenario fail closed. Old binaries that ignore loading requirements
are not supported rollback targets after activation. Do not restore a database
backup over new authoritative writes to undo activation.

## Native boundary and publication

Declarations cover the complete original dataset inventory. After day scoping,
fleet exclusions, overrides and retained manual decisions, the adapter takes
only the actual available vehicles and scoped requests. Stable application IDs
are compacted once for native input; route, witness and singleton-diagnostic IDs
are restored together. Reload rounds retain their native trip index.

The input includes explicit full-footprint slots, layers, clearance, payload,
stack limits, directed support classes and rear-unload access rules. HGS behavior,
existing scalar constraints, budgets and parameters remain intact. The native
packing node budget is 10,000; it is included in the exact request fingerprint.

Each certificate binds its exact plan ID, scenario/revision and safety snapshot,
ordered vehicle/round/request layout, unassigned inventory, immutable dataset and
physical-source hashes, actual native-request hash and executable SHA-256.
Executable bytes are hashed before and after execution; replacement during the
solve is rejected. Readiness and approval do not trust native FEASIBLE alone:
independent replay checks every unit, position, layer, support/weight/height,
payload and rear-unload rule. Missing, duplicated, foreign and UNKNOWN evidence
cannot become authoritative solver results. UNKNOWN singleton diagnostics also
fail publication; an infeasible load may produce an unassigned draft, which
cannot be approved with incomplete service.

The certificate keeps the immutable source JSON compressed once, so subsequent
checks can verify its source hash and replay without an R2 request or native
search while holding a database lock. Decompression is bounded at 64 MiB;
the importer retains its 100,000-unit dataset and 128-unit/request limits.
Per-round checking is bounded at 128 units. No solver workspace is retained.

Completion rechecks current scenario/source requirements and certificate binding
inside the existing lease/fencing transaction. A stale worker cannot complete
the job or insert its plan. This does not replace the monotonic PostgreSQL fence.
No converter, HTTP solver service, new database or migration is introduced.

## Review, edits and exports

Manual planning remains available. Previews and suggested positions explicitly
state that their checked scalar constraints do not verify physical loading.
Saving creates an unverified draft and removes the parent's certificate;
reordering, reassignment, vehicle exclusion and undo cannot reuse its proof.
Replan must generate new native evidence before approval. Ordinary draft exports
remain available, including their blockers; Approved exports re-read and verify
current evidence under the existing scenario lock. Scenario/profile/input edits
and a changed physical source invalidate approval. Exports retain the exact
physical certificate with the other constraint snapshots.

The existing Constraints panel shows server-confirmed witnesses, stale evidence
or unconfirmed status in EN/HU. It cannot show Verified while the authoritative
workflow check is unavailable or reports a physical blocker. For unassigned
orders it shows native singleton loading counts with their strict scope:
loading compatibility alone is not proof of why an order is unassigned, nor of
insertability into an existing route. No assigned rounds is stated explicitly.

## Verification

- Unit/native: sparse IDs, filtered fleets/days, source and layout tampering,
  physical constraints, manual invalidation and actual HGS/UNKNOWN execution.
- PostgreSQL/S3 integration: real multipart admission and two HTTP servers,
  native execution, takeover, corrupt/stale publication rejection, cross-replica
  approval/export and post-edit rejection.
- Playwright: normal image workflow plus real loading admission, native solve,
  approval/export, manual UI warning/save/replan, infeasible loads and EN/HU copy.
  CI runs complete acceptance with the flag both off and on, using public facts.

```
make -C vendor/otto/shared lib
make -C vendor/otto/arbor lib
make -C vendor/otto/surge surge_solve
CURSUS_TEST_SURGE_BIN="$PWD/vendor/otto/surge/surge_solve" npm --prefix server run test:ci
python3 deploy/acceptance.py --report /external/evidence/loading-off.json
python3 deploy/acceptance.py --hard-loading --report /external/evidence/loading-on.json
```

Use the existing disposable PostgreSQL/S3 integration environment for
`npm --prefix server run test:stateful`; the native binary must match the host.
The acceptance report records the policy. The release-evidence validator rejects
an off-policy report for an explicitly requested hard-policy target and vice
versa. Image identity alone does not certify a runtime configuration.

Gyermelyi needs verified load-unit geometry/support facts and vehicle loading
geometry before a separate activation review. Arbitrary 3D packing, axle loads,
pickups/initial cargo and automatic database failover are outside this model.
