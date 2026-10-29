# Recovering a saved planning workspace

Plan records and route geometry have different readiness requirements. The
persisted scenario, selected plan, delivery identities and KPIs must load without
waiting for Velo to draw the roads.

Both runtimes accept `GET /api/plans/:id?geometry=stored`. This returns the
tenant-authorized stored plan and any geometry already present, without making
a Velo request. The default endpoint retains road enrichment. Unknown geometry
modes fail with HTTP 400; plan responses are private and not cacheable.

On reload, Cursus resolves the saved workspace and its current selected plan
before displaying a baseline. The bookmark remains intact during initialization
and transient API failures. A genuinely deleted plan falls back to its planning
day. Slow or unavailable roads cannot silently replace the saved workspace.

Missing geometry is fetched separately. Late responses may only add valid roads
to matching immutable plan/trip/delivery identities; they cannot replace KPIs,
decisions or another plan. Cosmetic geometry changes do not close manual dialogs,
invalidate an unchanged preview or change its operation identity.

Regression coverage includes an actual PostgreSQL/API test with blocked road
enrichment, a pure geometry-merge test, and a browser workflow with a transient
metadata failure, delayed roads and an open manual preview. Customer-data
stabilization evidence stays outside the checkout and CI artifacts. Production
deployment requires a separate rollout; running the tests does not change it.
