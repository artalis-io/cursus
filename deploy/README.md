# Portable Cursus deployment

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
`a549fdca3fdba2148b6f034754e99e77f6b86729`. `OTTO_ROOT` controls the checkout
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
# Edit every /absolute/path and replace DISPATCH_AUTH_TOKEN.
mkdir -p /your/cursus-state /your/osm-assets
# Make state writable by CURSUS_UID:CURSUS_GID (10001:10001 by default).
docker compose config --quiet
docker compose build
```

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
docker compose up -d --no-build --pull never
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
