# Tenant isolation and workspace switching design

Status: proposed tenant-switching design, not implemented. The separate
label-only delivery is described below. This document does not authorize
application changes, tenant creation, membership grants, migrations or production
deployment. It records the review of source revision
`1fe21b5fd700f6c21458015d16cce4a6e7065d7b` and read-only production metadata
checks on 15 October 2026.

## Summary

Cursus has application-enforced tenant scoping for authoritative PostgreSQL
records and immutable object artifacts. Its HTTP runtime nevertheless serves
one configured tenant per deployment. Safe switching requires request-scoped
authorization and removal of customer-specific process-wide defaults; a
workspace dropdown alone is insufficient.

Show **Gyermelyi** as the workspace name beside the Cursus brand. Preserve the
existing tenant ID and data ownership. Allow switching only among authorized
workspaces, with platform-wide access requiring a distinct, explicit grant.

## Current protections and limits

### Authentication and authoritative records

- [Authentication](../server/src/state/auth.ts) checks session expiry,
  revocation and membership. Sessions currently contain a tenant ID, and only
  the `admin` membership role is supported.
- The [HTTP guard](../server/src/state/api.ts) rejects a principal whose tenant
  differs from the deployment's configured tenant. Scenario and dataset
  repositories are constructed with that same tenant at startup.
- [Store queries](../server/src/state/postgres.ts) scope scenarios, plans,
  datasets and jobs by tenant. Core records use composite tenant/entity keys in
  [the schema](../server/migrations/001_stateful.sql).
- Durable jobs carry the tenant in their leases. Result and admission writes
  include tenant, ownership and fencing predicates. Workers intentionally claim
  jobs across tenants; they are trusted backend components, not user clients.

The current model is a tenant-aware persistence layer behind a single-tenant
HTTP deployment, not an implemented tenant-switching API.

### Object storage

[Object writes](../server/src/state/objects.ts) use
`tenants/<tenant-id>/sha256/<checksum>` keys. The
[solver dataset loader](../server/src/state/conversion.ts) checks that admitted
request and geocoded artifact keys belong to the expected tenant before reading
them. PostgreSQL admission remains the visibility boundary.

This is logical namespacing, not a separate storage credential per customer.
`ObjectStore.getVerified()` verifies bytes and checksums but does not itself
receive a tenant argument; callers must establish ownership. All customer-object
read paths need a consistent tenant-bound contract before general switching.

### Database security

The production metadata checks found RLS disabled on `scenarios`, `plans`,
`datasets` and `jobs`. Connections with application name `cursus` used a database
role with superuser and `BYPASSRLS` privileges.

Consequently, database access does not independently enforce the application
tenant boundary. A missing tenant predicate in backend code is not stopped by
RLS. PostgreSQL also explicitly permits superusers and `BYPASSRLS` roles to
[bypass row security](https://www.postgresql.org/docs/16/ddl-rowsecurity.html).

Before onboarding independent customers, introduce a restricted runtime role,
separate migration privileges and tenant policies as defense in depth. Normal
runtime startup currently runs migrations, so changing the connection role alone
would be insufficient. Any pooled-connection tenant context must be
transaction-local and fail closed when absent; it must never persist into the
next request. Trusted worker claim and publication permissions need an explicit
design alongside HTTP permissions.

### Remaining customer-specific defaults

These paths are blockers for general multi-customer operation:

- [Dataset admission](../server/src/data/admit.ts) clones the built-in day-one
  request for depot, fleet and configuration. An uploaded fleet replaces only
  part of this template.
- [Trip evaluation](../server/src/state/api.ts) tries the process-wide
  `loadDay()` before looking up an admitted tenant dataset. Matching legacy day
  IDs could select the wrong customer's inputs in a shared runtime.
- [Vehicle enrichment](../server/src/data/dataset.ts) reads local
  `input/vehicles.json`; conversion and evaluation use that information.
- [Tariffs](../server/src/cost.ts) resolve through the process-wide dataset root.
- Customer-specific geocoding caches and other local state require an ownership
  inventory. A private customer's input must not silently become another
  tenant's fallback.

Use explicit tenant-owned admitted artifacts and configuration snapshots for
fleet, depots, tariffs and evaluation. Keep any necessary legacy adapter
explicitly bound to its owning tenant, with no fallback for other tenants.
Public OSM assets may remain shared and read-only; they are distinct from
customer input and customer-specific derived state.

### Production identity and existing coverage

At review time, the production database contained one tenant with ID
`production`, display name `Cursus`, and five admin memberships. No user email
addresses or credentials belong in this document or repository.

Display **Gyermelyi** without renaming the internal ID, changing foreign keys or
moving existing R2 objects. Startup currently upserts the configured tenant name
through `ensureTenant()`: changing only a database label would be overwritten
later. Define the display-name source of truth and bootstrap behavior together.

Existing [integration tests](../server/src/state/integration.test.ts) and
[production-image browser tests](../web/acceptance/runtime.spec.ts) cover selected
foreign-tenant reads and exports returning 404. They do not establish safe
switching, customer-default isolation or database-enforced isolation. The review
did not run new tests or establish an active cross-customer exposure.

## Authorization model

| Capability | Tenant admin | Explicit multi-tenant member | Platform admin |
| --- | --- | --- | --- |
| Work in Gyermelyi | Requires Gyermelyi membership | Requires Gyermelyi membership | Requires separately defined platform authority |
| Switch workspace | Only to another authorized membership | Among explicitly authorized memberships | Across the separately approved scope |
| Access unrelated customers | No | No | Only through an explicit platform grant and audited access |

`Admin` currently means tenant admin. Do not promote the five existing admins
to platform administrators as a side effect of enabling the switcher. Likewise,
being on the login allowlist must not grant membership in every tenant.

**Open decision:** should the operator receive explicit memberships in selected
tenants, or a separate platform-admin permission? Explicit memberships are the
default recommendation. Platform-wide access remains disabled until its scope,
grant/revocation mechanism and audit requirements are approved. Broader planner
or viewer roles are outside this design's initial implementation scope.

## Workspace experience

### Label-only delivery

The separate label-only change exposes the authenticated tenant's display name
through `/api/auth/me` and renders it as static header text. It adds no tenant
selector, memberships, role grants or switching endpoints. Missing display-name
metadata falls back to the existing Dispatch branding rather than guessing a
customer name.

At its separately approved production rollout, set the existing external
`CURSUS_TENANT_NAME=Gyermelyi` setting consistently on both replicas. Keep
`CURSUS_TENANT_ID=production` unchanged. Normal startup updates the existing
tenant's display name through the current bootstrap behavior; no object move,
schema migration or manual SQL rename is required. Do not change only the
database label while leaving the old startup setting in place. The example
environment file and application image remain customer-neutral.

### Proposed switching experience

The header displays `Cursus / Gyermelyi`. The existing footer continues to show
the signed-in user, role, build and Sign out.

- Show a simple workspace label for one authorized tenant; enable the dropdown
  when multiple authorized tenants are available. Do not list unauthorized or
  staging tenants.
- List human-readable names and the user's role in each authorized workspace.
  Tenant names come from the backend, not a hardcoded customer string.
- Put workspace context in the browser URL so separate tabs can use different
  tenants safely. A global session-level switch must not silently retarget an
  already-open tab.
- Before leaving a workspace, confirm unapplied local edits. Do not implicitly
  discard changes, cancel authoritative jobs or transfer data.
- Abort outstanding browser requests on switching, clear tenant-specific UI
  state, and key caches by tenant and entity. Ignore late responses belonging to
  the old workspace, including solve polling, previews and exports.
- Keep jobs and email intents attached to their original tenant. Switching only
  changes what the user is viewing; it does not reassign background work.
- If membership is revoked, stop access on subsequent requests and clear the
  affected workspace from the UI. Revocation must work across both replicas.

## Backend contract

Separate signed-in identity from the tenant requested by an operation. Resolve
an immutable request context containing user ID, tenant ID, role and authorized
capabilities. Validate current membership or separately approved platform
authority on every tenant operation; a client-supplied tenant selector is never
proof of access.

Proposed interfaces, subject to implementation review:

- `GET /api/workspaces`: authenticated listing of authorized workspaces only.
- Browser routes such as `/workspaces/<tenant-id>/...`.
- Tenant-qualified resource routes such as
  `/api/tenants/<tenant-id>/plans/<plan-id>`, including downloads and exports.
- Authentication endpoints remain identity-level. Preserve current sessions and
  magic-link safety during a backward-compatible transition.

Construct tenant-bound repositories from the authorized request context. Never
mutate a shared repository's current tenant. Every lookup, mutation, comparison,
upload, artifact read, admission and export uses that same context. Choose a
consistent non-disclosing response for unauthorized tenant/resource access.

Preserve the current API through an explicit compatibility strategy during
rolling upgrades. An ambiguous or missing tenant context must not silently
select another customer. Audit membership changes and administrative access with
actor and tenant; never log tokens or private dataset contents.

Tenant data isolation does not guarantee resource fairness. Preserve bounded
worker concurrency and review per-tenant queue/concurrency controls before
allowing independent customers to compete for solver or conversion capacity.

## Verification required before switching is enabled

Use two non-confidential tenants with different fleets, depots, tariffs and
datasets, and deliberately identical entity IDs. Run two independent HTTP
replicas against the same PostgreSQL and object-store fixtures.

1. Reject unauthorized tenant listing and context selection; distinguish tenant
   administration from any explicitly granted platform administration.
2. Verify isolation for reads, edits, deletes, comparisons, history, exports,
   raw/canonical data, uploads, jobs and object references. Include forged tenant
   selectors and cross-tenant artifact keys.
3. Prove conversion, evaluation, enrichment and costs never use another
   customer's defaults, even when legacy day IDs and vehicle references collide.
4. Exercise two tabs, rapid workspace changes and deliberately late responses.
   The displayed tenant and every submitted mutation must remain consistent.
5. Verify membership revocation and logout across replicas without granting
   additional access through login or session renewal.
6. Switch while conversion/solve jobs run, force worker takeover, and verify
   fenced publication remains in the original tenant only.
7. If RLS is introduced, test actual restricted HTTP/worker roles, missing
   context, pooled-connection reuse, rejected cross-tenant writes and migration
   compatibility. Tests using only a superuser connection cannot prove RLS.
8. Extend required production-image Playwright acceptance with workspace naming,
   authorized switching, refresh/deep links, mobile layout and the failure cases
   above. Retain the complete Gyermelyi and native-planning regression coverage.

## Proposed implementation sequence

1. Approve membership versus platform-admin semantics and the display-name source
   of truth. A Gyermelyi label can be delivered independently of switching.
2. Remove or explicitly tenant-bind customer defaults; introduce request-scoped
   authorization, scoped object reads and the necessary database-role changes.
3. Implement compatible workspace APIs and UI switching, with the two-tenant
   integration and Playwright suite required before activation.
4. Review migration and rollback evidence, then obtain separate deployment and
   tenant-onboarding approval. Preserve existing tenant IDs, sessions, immutable
   objects and production writes throughout.

This is application tenancy work, not a change to Cloudflare topology,
PostgreSQL promotion, production data ownership or the legacy write freeze.
