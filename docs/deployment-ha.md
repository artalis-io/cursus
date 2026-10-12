# Cursus Cloudflare HA

This repository adopts the existing Cloudflare routing layer for
`cursus.artalis.io`; it does not create infrastructure. Desired state is in
[`deploy/ha.json`](../deploy/ha.json), with the standard-library CLI in
[`deploy/ha.py`](../deploy/ha.py).

## Architecture and ownership

Cloudflare's proxied load balancer sends traffic to an ordered primary pool and
then a secondary pool. Each pool has exactly one Cloudflare Tunnel origin. Both
tunnels route the Cursus hostname to `http://localhost:8080`; the monitor
requests `GET /health/ready` over HTTPS every 60 seconds. Steering is off, so
pool order is significant.

Herding Sparks owns node provisioning, SSH identity and Access, tunnel and
connector lifecycle, Docker/NVIDIA installation, and host security. Cursus owns
only its hostname ingress entry, existing LB topology, existing monitor and pool
settings, and application readiness contract. The reconciler has no DNS API
operations: DKIM, SPF, Return-Path, MX, DMARC, tracking, and all other DNS remain
outside its ownership. It preserves SSH ingress, unrelated ingress,
`warp-routing`, catch-alls, and unknown tunnel configuration fields.

Public IDs are intentionally checked in. The Cloudflare API token is read only
from `CF_API_TOKEN` or `~/.config/cloudflare/api-token`, which must be mode 0600.
It stays on the controller and is never sent to either Spark.

## Commands

Run from `control-mac` in the Cursus checkout:

```bash
python3 deploy/ha.py plan       # exact, read-only drift report
python3 deploy/ha.py status     # Cloudflare, SSH/local, and public status
python3 deploy/ha.py test       # read-only application probes
python3 -m unittest discover -s tests -p 'test_ha.py' -v
```

`status` labels its public request as a sample because one request cannot prove
global edge behavior.

### Applying approved drift

Never apply merely to make a warning disappear. Review `plan`, confirm both
nodes are ready, understand the impact, and obtain explicit production-change
approval. Then run:

```bash
python3 deploy/ha.py apply --approve
python3 deploy/ha.py plan
python3 deploy/ha.py status
```

Without `--approve`, `apply` refuses to run. It adopts resources by checked-in
ID, performs a fresh read before writes, never creates or deletes a resource,
refuses more than two origins, updates only Cursus-owned fields, and merges only
the Cursus tunnel ingress. Every write is re-read and verified. If one update
fails, remaining independent updates are attempted and the command reports a
partial apply; inspect and plan again before retrying. There is no automated
cleanup of former resources. Read calls retry transient failures with bounded
timeouts; mutations are not blindly retried.

## Optional bounded failover test

Normal `test` is always non-disruptive. Failover requires an explicit flag,
confirmation, and stop/start adapters. Adapters must control only the temporary
Hello World process—never use broad `pkill`, stop a tunnel, or target Cursus.

```bash
python3 deploy/ha.py test --failover --confirm-failover \
  --stop-command 'EXACT_TEMPORARY_SERVER_STOP_COMMAND' \
  --start-command 'EXACT_TEMPORARY_SERVER_START_COMMAND' \
  --wait-seconds 240
```

It first requires full secondary pool health and local readiness, uses bounded
polling, restores primary in `finally` and signal handlers, and measures observed
failover/failback. Adapters are not stored because future production lifecycle
will differ. A controller failure can defeat cleanup; recover by SSHing to the
primary, running the exact start adapter, checking local readiness, then running
`status`.

## Recovery and troubleshooting

- Authorization errors: use the existing account-scoped token with Load
  Balancing and Tunnel configuration permissions. No user-token endpoint is
  used.
- Unexpected drift: do not apply until ownership is clear. Duplicate Cursus
  hostname rules are flagged, while unrelated configuration is preserved.
- Unhealthy origin: request `http://127.0.0.1:8080/health/ready` over SSH and
  inspect the process without stopping its tunnel.
- Partial apply: save output and run `plan` again. The CLI avoids an automatic
  rollback that could overwrite newer shared configuration.
- Lost token: restore it only on `control-mac` with mode 0600. Never copy it into
  a repository, image, Compose secret, Spark, or log.

## Future Cursus deployment contract

This facility does **not** deploy Cursus. A future deployment must run identical,
pinned native ARM64 images on both nodes, bind locally at `127.0.0.1:8080`, and
return HTTP 200 from `/health/ready` only when safe to serve. Lifecycle commands
must be explicit and bounded; connectors remain independent of the application.

Routing HA is proven, but application/data HA is not. Before deploying two real
replicas, design and test database consistency/failover, node-independent
sessions, uploads, generated plans, job ownership/fencing, background-job
deduplication, and Resend magic-link/email idempotency. SQLite on two hosts is
not a shared HA database. Backups do not supply consistency, and Cloudflare
affinity is `none`. Until then, do not claim end-to-end HA or run active-active
stateful Cursus.

The two-origin plan limit is an invariant. The former test LB and unused monitor
are absent from desired state and are never automatically deleted if found.

API behavior follows Cloudflare's official documentation for
[load balancers](https://developers.cloudflare.com/api/resources/load_balancers/),
[pool health](https://developers.cloudflare.com/api/resources/load_balancers/subresources/pools/subresources/health/methods/get/),
and [remotely managed tunnel configuration](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/remote-management/configuration-file/).
