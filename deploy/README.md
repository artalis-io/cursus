# Portable Cursus deployment

For the stateful two-Spark deployment, reboot recovery is managed by the existing
production tooling: `python3 deploy/cutover.py recovery status`. Approved
provisioning installs the schedule; existing installations can adopt it with
`python3 deploy/cutover.py recovery install --approve`. See
[reboot recovery](../docs/reboot-recovery.md) for maintenance, removal and limits.

This Compose deployment builds Cursus and every OTTO component locally. It is
designed for native Linux ARM64 (including DGX Spark) and Linux AMD64; normal
operation does not use a GPU or emulation. The only registry downloads are the
public Debian, Node, distroless and BusyBox base images referenced by the
Dockerfiles.

## Components and data flow

The default persistent stack is Cursus (frontend and API on one port), Velo
(routing/geometry) and Carta (tiles). Only Cursus is published, on host loopback
by default. Velo and Carta live solely on the internal Compose network. Locus is
not used by Cursus at runtime, but can be started internally with the optional
`geocoding` profile. `osm-prepare` is a completed one-shot job, not a service.
Surge and `matrix_build` are native executables inside the Cursus image and are
spawned through the existing Cursus interfaces.

The deployment pins OTTO commit
`367061d015f6776f7ea27fb01726c1a14cb4614c`. `OTTO_ROOT` controls the checkout
used to build OTTO service/preparation images and accepts Compose-supported
relative or absolute paths. The Cursus application image deliberately builds
its native CLI tools from the pinned `vendor/otto` submodule, keeping its Docker
build context reproducible. Before an upgrade, update both the submodule and
`OTTO_REVISION` to the same reviewed commit.

## Configure and build

Docker Engine and Docker Compose must already be installed by the host owner.
From the Cursus checkout:

```sh
cp .env.example .env
# Edit every /absolute/path and configure the external authentication files.
mkdir -p /your/cursus-state /your/osm-assets
# Make state writable by CURSUS_UID:CURSUS_GID (10001:10001 by default).
docker compose config --quiet
docker compose build
```

Authentication uses one-time Resend magic links and a SQLite database under
`CURSUS_DATA_PATH`. Create two files outside the checkout before validating
Compose: `CURSUS_AUTH_ALLOWLIST_PATH` contains one approved email address per
line, and `RESEND_API_KEY_PATH` contains only the Resend API key. Neither file,
its contents, nor the addresses belong in `.env` or Git. Configure the verified
sender with `CURSUS_AUTH_FROM` and the external HTTPS URL with
`CURSUS_PUBLIC_ORIGIN`. The default sender is
`Cursus <login@cursus.artalis.io>` and does not need an inbox.

Magic-link challenges are hashed, expire after ten minutes and are one-use.
Sessions are revocable, expire after seven days, and use Secure, HttpOnly,
SameSite cookies. Plain allowlists bootstrap Admin membership; explicit JSON
allowlists also support read-only Reviewer membership. See [Access roles](../README.md#access-roles)
for the role matrix, private configuration, migration and audited operator command.
Existing roles are never elevated at login. SQLite runs in WAL mode; back up the database along
with the rest of `CURSUS_DATA_PATH`.

This release intentionally supports one configured tenant. Identity,
membership and audit records carry a tenant ID, but the existing dispatch
scenario/plan files remain a single-tenant store. Do not add a second tenant
until those domain records are tenant-keyed and isolation-tested.

`CURSUS_DATASET_PATH` is a pre-existing customer input directory and is mounted
read-only. Its current application schema is unchanged: `input/orders.json`,
`input/orders.geocoded.json`, `input/vehicles.json`, plus the two existing
`results/perday/dayN_{request,solution}.json` pairs are required. The image build
never sees this directory. `CURSUS_DATA_PATH` contains plans, jobs, uploads,
caches and a checksum-only dataset identity record; back it up independently.
Compose uses `create_host_path: false`, so misspelled paths fail instead of
creating empty directories. Never put either directory below the checkout.

## Prepare geographic assets

OSM inputs and customer data are separate. `OSM_DATA_PATH` is an existing host
directory that can be shared read-only by multiple deployments. Preparation is
explicit:

```sh
docker compose --profile prepare run --rm osm-prepare
```

If `OSM_PBF_FILE` exists, it is reused without network access. Otherwise the job
downloads `OSM_PBF_URL` with redirect following, HTTP failure handling, retries,
timeouts and same-filesystem temporary storage, then validates minimum size and
atomically renames it. Set an empty URL to make a missing source a hard failure.
To use another extract, set both values; Hungary is only the default.

The job holds an exclusive lock, reports source/free/estimated disk bytes, and
runs OTTO's Velo, Carta and Locus converters. It identities output by PBF SHA-256,
OTTO revision and converter-binary SHA-256. Output is built and natively checked
in a staging directory, then published by an atomic `current` symlink only after
success. A `COMPLETE` marker and manifest distinguish valid output from partial
files. Matching output is reused; changed inputs or converters create a new
version while the old version remains usable. An interrupted job cannot replace
`current`. Old versions are retained for rollback and may be removed manually
only after confirming no deployment uses them.

## Operate

```sh
docker compose up -d --no-build
docker compose ps
./deploy/smoke.sh
docker compose logs -f cursus velo carta
docker compose restart cursus
docker compose down
```

`restart: unless-stopped` brings persistent services back after Docker/host
restart. `down` preserves all bind-mounted state and geographic assets. To run
the optional internal Locus service: `docker compose --profile geocoding up -d
locus`. It has no host port.

For upgrades, stop the stack, back up `CURSUS_DATA_PATH` and the active OSM
manifest, update Cursus plus the pinned OTTO checkout/submodule, rebuild, rerun
the prepare job (it reuses compatible assets), then start with `--no-build
--pull never`. Roll back source and repoint the managed `current` symlink to the
prior completed version if necessary.

An externally managed Cloudflare Tunnel may target
`http://127.0.0.1:${CURSUS_PORT}`. Cursus does not install or configure it and
does not require DNS or Internet after preparation. The current auth token is a
safe-bind guard, not an HTTP authentication scheme; external publication must
be protected by Cloudflare Access or another trusted authenticating proxy.

## Verification and troubleshooting

### Import previously audited selected plans

`deploy/import-selected.py` prepares a private batch from an external,
checksummed selection archive. It verifies the admitted production dataset,
fully served/validated plans, road geometry and replication. Apply requires an
exact application image on both replicas, explicit approval, and a private
pre-import database dump with a matching `.verified.json` restore-evidence
sidecar (`sha256`, `restoreVerified`, `createdAt`, `systemIdentifier`).

```sh
python3 deploy/import-selected.py plan --selection /private/selection/manifest.json \
  --batch /private/import-batch.json --image sha256:EXACT_APPROVED_IMAGE
python3 deploy/import-selected.py apply --batch /private/import-batch.json \
  --backup /private/pre-import.dump --approve
```

The short transaction locks and checks both base scenarios, refuses active
solves or partial/conflicting imports, appends two uniquely named saved plans,
and records an audit event. Existing plans, datasets, sessions and email state
are not rewritten. Both policies and plans publish together; exact retries are
no-ops. Import never restores a backup over production writes. The newer saved
plans become the default day/week baselines; all earlier plans remain in history.
Exception approval is not confirmation of customer access/unloading arrangements.

Run repository-safe checks with `./deploy/test-prepare.sh`. A tiny public Monaco
fixture under `deploy/fixtures/smoke` supports container/API tests only and is
excluded from image build contexts; it is not a substitute for customer data.
The smoke script
checks the frontend, API health and Carta proxy. A full private workflow must be
run only where the customer dataset is legitimately available; no private test
fixture is stored here.

- A missing dataset file is named without logging its contents.
- A missing `current/map.*` means preparation has not completed for
  `OSM_ASSET_NAME`, or `.env` points at the wrong shared asset directory.
- Permission errors under `/state` mean the host directory does not match
  `CURSUS_UID`/`CURSUS_GID`.
- Inspect `docker compose ps` and service logs for native index-format errors.
- Preparation never migrates or overwrites customer data and never overwrites
  an existing PBF. Remove a known-bad PBF manually only after independent review.

No speculative resource limits are imposed. Use `docker stats --no-stream` and
job elapsed time in the API to establish workload-specific sizing.
