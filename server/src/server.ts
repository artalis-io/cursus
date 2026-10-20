import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { existsSync, createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config, missingConfigPaths } from './config.js';
import { DAYS, allDayIds, loadDay, loadEnrichment, loadVehicleInfo } from './data/dataset.js';
import { admitDataset } from './data/admit.js';
import { allDatasets, unregisterDataset } from './data/registry.js';
import { mapSolutionToPlan } from './plan/mapper.js';
import { evaluateTrip } from './plan/evaluate.js';
import { fillPlanGeometry, veloReachable } from './geometry/velo.js';
import { validateScenarioEdit, exportScenario, parseScenarioImport, type ScenarioEdit } from './store.js';
import { store, enqueueSolve, cancelJob, hasSolveCapacity, shutdownSolves, type Objective } from './solve.js';
import { Semaphore } from './util/semaphore.js';
import { AuthService, cookieValue } from './auth.js';

/* A2: bound concurrent dataset admits (each holds a geocode + an N^2 matrix
 * build). Admits await a slot, surfacing as the 'queued' stage, rather than
 * running in parallel and OOMing the single process. */
const importSem = new Semaphore(config.maxConcurrentImports);
import { comparePlans } from './plan/compare.js';
import { weekSummary } from './plan/week.js';
import { importSummary, rawSample, canonicalSample } from './data/import.js';
import { sageReachable, narratePlan, narrateComparison, type Lang } from './sage.js';
import { loadTariff } from './cost.js';
import { planToCsv, planToRouteSheetHtml, planToRoutesCsv, planToHandoffJson } from './export.js';
import { magicLinkConfirmation, magicLinkLanguage, registerMagicLinkFormParser } from './magic-link.js';
import { registerWorkspaceBranding } from './workspace-branding.js';
import { RateLimiter } from './ratelimit.js';
import { CATALOG, suggestMapping, type Entity } from './data/catalog.js';
import { newUploadPath, uploadPath, sampleUpload, runIngestPreview, runGeocode, extFromName, type Mapping } from './data/onboard.js';
import type { Plan } from './types.js';
import { buildInfo } from './build-info.js';
import { registerAccessControl, viewIdentity } from './access-control.js';
import { rolePermissions } from './roles.js';

const ENTITIES: Entity[] = ['orders', 'vehicles', 'routes'];

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 4 * 1024 * 1024 });
registerMagicLinkFormParser(app);
const auth = config.authRequired ? new AuthService({
  databasePath: config.authDatabase,
  allowedEmailsFile: config.authAllowedEmailsFile,
  resendApiKeyFile: config.resendApiKeyFile,
  publicOrigin: config.authPublicOrigin,
  from: config.authFrom,
  tenantId: config.authTenantId,
  tenantName: config.authTenantName,
  secureCookies: config.authPublicOrigin.startsWith('https://'),
}) : null;

// Consistent JSON error envelope; never leak a stack to the client.
app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) app.log.error({ err, url: req.url }, 'request failed');
  reply.code(status).send({ error: status >= 500 ? 'internal error' : err.message });
});
// Don't let a stray async rejection take the process down silently.
process.on('unhandledRejection', (reason) => app.log.error({ reason }, 'unhandledRejection'));

// A5: security headers on every response + default-deny CORS. Hand-rolled (no
// new deps), matching the existing hand-rolled rate limiter.
const corsAllow = new Set(config.corsOrigins);
app.addHook('onRequest', (req, reply, done) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Strict-Transport-Security', 'max-age=15552000');
  reply.header('Content-Security-Policy', config.contentSecurityPolicy);
  // CORS: only reflect an explicitly allow-listed Origin; otherwise emit nothing
  // (same-origin requests are unaffected; cross-origin is denied by default).
  const origin = req.headers.origin;
  if (origin && corsAllow.has(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { reply.code(204).send(); return; }
  } else if (req.method === 'OPTIONS' && req.url.startsWith('/api')) {
    reply.code(204).send(); return;   // preflight for a non-allowed origin: no CORS headers
  }
  done();
});

// Browser sessions are tenant memberships, not bearer tokens in JavaScript.
// Static assets, health and the login exchange stay public; application APIs
// and map tiles require a tenant membership; mutations additionally require Admin.
registerAccessControl(app, auth ? { authenticate: token => auth.authenticate(token),
  audit: (principal, detail) => auth.recordAccessAudit(principal, detail),
  tenantId: config.authTenantId, publicOrigin: config.authPublicOrigin } : undefined);
registerWorkspaceBranding(app, config.authTenantName);

// Per-IP rate limit. The API surface uses the standard bucket; the tile proxy
// gets its own, more generous bucket (was unthrottled). Health is exempt.
const limiter = new RateLimiter(config.rateLimitRps, config.rateLimitBurst);
const tileLimiter = new RateLimiter(config.tileRateRps, config.tileRateBurst);
app.addHook('onRequest', (req, reply, done) => {
  const ip = req.ip || 'unknown';
  if (req.url.startsWith('/tiles')) {
    if (!tileLimiter.allow(ip)) { reply.code(429).send({ error: 'too many tile requests' }); return; }
    return done();
  }
  if (!req.url.startsWith('/api') || req.url.startsWith('/api/health')) return done();
  if (!limiter.allow(ip)) { reply.code(429).send({ error: 'too many requests' }); return; }
  done();
});

// Multipart uploads (onboarding). Bounded file size; one file per request.
await app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadMB * 1024 * 1024, files: 1, fields: 4 } });

const enrichment = loadEnrichment();
const vehicleInfo = loadVehicleInfo();

/* ---- Baselines: immutable base scenario + saved real plan per day ---- */
function buildBaseline(dayId: string, label: string): Plan {
  const scenario = store.ensureBaseScenario(dayId, label);
  const day = loadDay(dayId);
  const plan = mapSolutionToPlan({
    day, request: day.request, solution: day.solution,
    enrichment: day.enrichment, vehicleInfo,
    scenarioId: scenario.id, scenarioRevision: 0,
    planId: `${dayId}-baseline`, source: 'saved',
    createdAt: new Date(0).toISOString(),
  });
  store.putPlan(plan, false); // derived at startup; not persisted
  return plan;
}
for (const d of allDayIds()) {
  try { const p = buildBaseline(d.id, d.label); app.log.info(`baseline ${d.id}: ${p.stats.servedOrders}/${p.stats.totalOrders} served`); }
  catch (e) { app.log.error(`baseline ${d.id} failed: ${(e as Error).message}`); }
}

// Background: precompute baseline geometry so the first UI load is complete.
void (async () => {
  if (!(await veloReachable())) { app.log.warn('velo not reachable; geometry fills lazily'); return; }
  for (const d of DAYS) {
    const p = store.getPlan(`${d.id}-baseline`);
    if (!p) continue;
    try {
      await fillPlanGeometry(p);
      const trips = p.vehicles.reduce((n, v) => n + v.trips.length, 0);
      const filled = p.vehicles.reduce((n, v) => n + v.trips.filter((t) => t.geometry).length, 0);
      app.log.info(`geometry ${d.id}: ${filled}/${trips} trips`);
    } catch (e) { app.log.warn(`geometry ${d.id} failed: ${(e as Error).message}`); }
  }
})();

/* ---- Meta ---- */
app.get('/api/health', async () => ({ status: 'ok', service: 'cursus-api', days: DAYS.map((d) => d.id) }));
app.post<{ Body: { email?: string } }>('/api/auth/magic-link', async (req, reply) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  if (auth && email) {
    try { await auth.requestMagicLink(email); }
    catch (err) { app.log.error({ err }, 'magic-link delivery failed'); }
  }
  return reply.code(202).send({ accepted: true });
});
app.get<{ Querystring: { token?: string; lang?: string } }>('/api/auth/verify', async (req, reply) => {
  if (!auth || !req.query.token) return reply.redirect('/?auth=invalid');
  return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8')
    .send(magicLinkConfirmation(req.query.token, config.authTenantName, magicLinkLanguage(req.query.lang, req.headers['accept-language'])));
});
app.post<{ Querystring: { token?: string } }>('/api/auth/verify', async (req, reply) => {
  const session = auth && req.query.token ? auth.consumeMagicLink(req.query.token) : null;
  if (!session) return reply.redirect('/?auth=invalid');
  reply.header('Set-Cookie', auth!.cookie(session));
  return reply.redirect('/');
});
app.get('/api/auth/me', async (req, reply) => {
  reply.header('Cache-Control', 'private, no-store');
  if (!auth) return { email: 'local@cursus', tenantId: 'local', tenantName: config.authTenantName, role: 'admin', permissions: rolePermissions.admin.filter(p => p !== 'role.preview'), build: buildInfo };
  const principal = auth.authenticate(cookieValue(req.headers.cookie, 'cursus_session'));
  if (!principal) return reply.code(401).send({ error: 'authentication required' });
  return { ...viewIdentity(principal, req.headers.cookie), tenantName: config.authTenantName, build: buildInfo };
});
app.post('/api/auth/logout', async (req, reply) => {
  if (auth && req.headers.origin !== config.authPublicOrigin) return reply.code(403).send({ error: 'invalid request origin' });
  auth?.logout(cookieValue(req.headers.cookie, 'cursus_session'));
  if (auth) reply.header('Set-Cookie', auth.clearCookie());
  return { ok: true };
});
app.get('/api/config', async () => {
  const tariff = loadTariff();
  return {
    carta: config.cartaOrigin, velo: config.veloOrigin, solveTimeSeconds: config.solveTimeSeconds,
    cost: { available: true, currency: tariff.currency, source: tariff.source },
  };
});

app.get('/api/days', async () => allDayIds().map((d) => {
  const plan = store.getPlan(`${d.id}-baseline`);
  return {
    id: d.id, isoDate: d.isoDate, label: d.label, datasetLabel: d.datasetLabel ?? null,
    orders: plan?.stats.totalOrders ?? null,
    vehicles: plan?.vehicles.length ?? null,
    baseScenarioId: `${d.id}-base`,
    baselinePlanId: `${d.id}-baseline`,
  };
}));

/* ---- Scenarios ---- */
app.post<{ Body: { day?: string; from?: string; removeVehicleId?: number; label?: string } }>('/api/scenarios', async (req, reply) => {
  const { day, from, removeVehicleId, label } = req.body ?? {};
  if (from) {
    const parent = store.getScenario(from);
    if (!parent) return reply.code(404).send({ error: 'parent scenario not found' });
    const s = store.createCopy(parent, { removeVehicleId }, label);
    return reply.code(201).send(s);
  }
  if (day) {
    const def = DAYS.find((d) => d.id === day);
    if (!def) return reply.code(400).send({ error: 'unknown day' });
    return store.ensureBaseScenario(day, def.label);
  }
  return reply.code(400).send({ error: 'day or from required' });
});

/* Apply a manual dispatcher edit (pin/forbid/remove-vehicle...). Forks an
 * editable copy from an immutable base so the baseline is never mutated; edits
 * an existing copy in place. Returns the (possibly new) scenario. */
app.post<{ Params: { id: string }; Body: { edit?: ScenarioEdit; label?: string } }>('/api/scenarios/:id/edit', async (req, reply) => {
  const cur = store.getScenario(req.params.id);
  if (!cur) return reply.code(404).send({ error: 'scenario not found' });
  const edit = req.body?.edit;
  const invalid = validateScenarioEdit(edit);
  if (invalid) return reply.code(400).send({ error: invalid });
  if (req.body?.label != null && (typeof req.body.label !== 'string' || req.body.label.length > 120)) return reply.code(400).send({ error: 'invalid label' });
  try {
    const forked = cur.kind === 'base';
    const target = store.forkForEdit(cur, req.body?.label);
    const updated = store.editScenario(target.id, edit as ScenarioEdit);
    return reply.code(forked ? 201 : 200).send(updated);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

/* Bulk edit: apply several staged edits in one shot (e.g. assign many unassigned
 * orders to a vehicle). Forks a copy once and persists once. */
app.post<{ Params: { id: string }; Body: { edits?: unknown; label?: string } }>('/api/scenarios/:id/edits', async (req, reply) => {
  const cur = store.getScenario(req.params.id);
  if (!cur) return reply.code(404).send({ error: 'scenario not found' });
  const edits = req.body?.edits;
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 1000) return reply.code(400).send({ error: 'edits must be a non-empty array (<=1000)' });
  for (const e of edits) { const invalid = validateScenarioEdit(e); if (invalid) return reply.code(400).send({ error: invalid }); }
  if (req.body?.label != null && (typeof req.body.label !== 'string' || req.body.label.length > 120)) return reply.code(400).send({ error: 'invalid label' });
  try {
    const forked = cur.kind === 'base';
    const target = store.forkForEdit(cur, req.body?.label);
    const updated = store.editScenarioBatch(target.id, edits as ScenarioEdit[]);
    return reply.code(forked ? 201 : 200).send(updated);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.get<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
  const s = store.getScenario(req.params.id);
  if (!s) return reply.code(404).send({ error: 'scenario not found' });
  const day = loadDay(s.day);
  const availableVehicles = day.request.vehicles.filter((v) => !s.removedVehicleIds.includes(v.id));
  return {
    ...s,
    ordersInScope: day.scopeTaskIds.size,
    vehicleCount: availableVehicles.length,
    depot: day.depot,
    isoDate: day.def.isoDate,
  };
});

app.get<{ Params: { id: string } }>('/api/scenarios/:id/plans', async (req, reply) => {
  if (!store.getScenario(req.params.id)) return reply.code(404).send({ error: 'scenario not found' });
  return store.plansForScenario(req.params.id).map((p) => ({
    id: p.id, source: p.source, createdAt: p.createdAt,
    termination: p.provenance.termination, stats: p.stats,
  }));
});

/* ---- Scenario workspace (what-if): list a day's scenarios with their latest
 * result, rename, and delete copies. ---- */
app.get<{ Querystring: { day?: string } }>('/api/scenarios', async (req, reply) => {
  const day = req.query.day;
  if (!day) return reply.code(400).send({ error: 'day query param required' });
  // A what-if is worth listing once it has a result to compare (or it's the
  // base reference); unsolved abandoned forks are noise.
  return store.scenariosForDay(day).filter((s) => s.kind === 'base' || store.latestPlanForScenario(s.id)).map((s) => {
    const latest = store.latestPlanForScenario(s.id);
    const changesCount = s.removedVehicleIds.length + s.pins.length + s.forbids.length + s.vehicleOverrides.length + s.sequences.length;
    return {
      id: s.id, label: s.label, kind: s.kind, revision: s.revision, changesCount,
      latest: latest ? {
        planId: latest.id, createdAt: latest.createdAt,
        servedOrders: latest.stats.servedOrders, totalOrders: latest.stats.totalOrders,
        vehiclesUsed: latest.stats.vehiclesUsed, totalDistanceKm: latest.stats.totalDistanceKm,
        unassigned: latest.unassigned.length,
        cost: latest.cost?.total ?? null, currency: latest.cost?.currency ?? null,
      } : null,
    };
  }).sort((a, b) => (a.kind === 'base' ? -1 : b.kind === 'base' ? 1 : a.id.localeCompare(b.id)));
});

app.post<{ Params: { id: string }; Body: { label?: string } }>('/api/scenarios/:id/rename', async (req, reply) => {
  const label = (req.body?.label ?? '').trim();
  if (!label || label.length > 120) return reply.code(400).send({ error: 'label required (<=120 chars)' });
  if (!store.getScenario(req.params.id)) return reply.code(404).send({ error: 'scenario not found' });
  return store.renameScenario(req.params.id, label);
});

app.delete<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
  const s = store.getScenario(req.params.id);
  if (!s) return reply.code(404).send({ error: 'scenario not found' });
  if (s.kind === 'base') return reply.code(400).send({ error: 'base scenario cannot be deleted' });
  return { deleted: store.deleteScenario(req.params.id) };
});

// Export a scenario as a portable bundle; import recreates it on the same day's base.
app.get<{ Params: { id: string } }>('/api/scenarios/:id/export', async (req, reply) => {
  const s = store.getScenario(req.params.id);
  if (!s) return reply.code(404).send({ error: 'scenario not found' });
  return exportScenario(s);
});
app.post('/api/scenarios/import', async (req, reply) => {
  const parsed = parseScenarioImport(req.body);
  if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
  if (!allDayIds().some((d) => d.id === parsed.day)) return reply.code(400).send({ error: `unknown day '${parsed.day}' (admit its dataset first)` });
  const base = store.ensureBaseScenario(parsed.day, loadDay(parsed.day).def.label);
  try { return store.importScenario(base, parsed.label, parsed.edits); }
  catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});

/* ---- Solve jobs ---- */
app.post<{ Params: { id: string }; Body: { budgetSec?: number; objective?: string; fullBudget?: boolean } }>('/api/scenarios/:id/solve', async (req, reply) => {
  const scenario = store.getScenario(req.params.id);
  if (!scenario) return reply.code(404).send({ error: 'scenario not found' });
  if (!hasSolveCapacity()) return reply.code(503).send({ error: 'solver busy, retry shortly' });
  const budget = Math.max(5, Math.min(600, req.body?.budgetSec ?? config.solveTimeSeconds));
  const objective: Objective = req.body?.objective === 'distance' ? 'distance' : 'vehicles';
  const fullBudget = req.body?.fullBudget === true;
  const job = store.createJob(scenario.id, scenario.revision);
  enqueueSolve(job, scenario, budget, objective, fullBudget); // off the event loop (child process)
  return reply.code(202).send({ jobId: job.id, scenarioId: scenario.id, scenarioRevision: scenario.revision, budgetSec: budget, objective, fullBudget });
});

app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
  const j = store.getJob(req.params.id);
  if (!j) return reply.code(404).send({ error: 'job not found' });
  // Report genuine elapsed while running (measured, not fabricated progress).
  if (j.status === 'running' && j.startedAt) {
    return { ...j, elapsedSec: Math.round(((Date.now() - Date.parse(j.startedAt)) / 1000) * 10) / 10 };
  }
  return j;
});

app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
  const j = store.getJob(req.params.id);
  if (!j) return reply.code(404).send({ error: 'job not found' });
  const ok = cancelJob(j);
  return { cancelled: ok, status: j.status };
});

/* ---- Plans ---- */
// List saved plans (baseline + persisted live plans), optionally by day, for reopen.
app.get<{ Querystring: { day?: string } }>('/api/plans', async (req) => {
  const out = [];
  for (const p of store.plans.values()) {
    const sc = store.getScenario(p.scenarioId);
    if (req.query.day && sc?.day !== req.query.day) continue;
    out.push({
      id: p.id, scenarioId: p.scenarioId, day: sc?.day ?? null,
      label: sc?.label ?? p.scenarioId, source: p.source, createdAt: p.createdAt,
      termination: p.provenance.termination,
      servedOrders: p.stats.servedOrders, totalOrders: p.stats.totalOrders,
      vehiclesUsed: p.stats.vehiclesUsed, totalDistanceKm: p.stats.totalDistanceKm,
    });
  }
  out.sort((a, b) => (a.source === 'saved' ? 0 : 1) - (b.source === 'saved' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt));
  return out;
});

app.get<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return reply.code(404).send({ error: 'plan not found' });
  try { await fillPlanGeometry(plan); } catch (e) { app.log.warn(`geometry fill: ${(e as Error).message}`); }
  return plan;
});

/* ---- Operational exports (stops CSV, printable route sheets) ---- */
function dayLabelForPlan(plan: Plan): string {
  return DAYS.find((d) => d.isoDate === plan.day)?.label ?? plan.day;
}
app.get<{ Params: { id: string } }>('/api/plans/:id/export.csv', async (req, reply) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return reply.code(404).send({ error: 'plan not found' });
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="otto-plan-${plan.day}-${plan.id}.csv"`);
  return reply.send(planToCsv(plan));
});
app.get<{ Params: { id: string } }>('/api/plans/:id/routesheet.html', async (req, reply) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return reply.code(404).send({ error: 'plan not found' });
  reply.header('content-type', 'text/html; charset=utf-8');
  return reply.send(planToRouteSheetHtml(plan, dayLabelForPlan(plan)));
});
// Outbound handoff: the tuned plan in the customer's route schema (re-importable)
// + a clean structured dispatch-plan document. plan.day is the ISO date.
app.get<{ Params: { id: string } }>('/api/plans/:id/routes.csv', async (req, reply) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return reply.code(404).send({ error: 'plan not found' });
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="otto-routes-${plan.day}.csv"`);
  return reply.send(planToRoutesCsv(plan, plan.day));
});
app.get<{ Params: { id: string } }>('/api/plans/:id/handoff.json', async (req, reply) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return reply.code(404).send({ error: 'plan not found' });
  reply.header('content-disposition', `attachment; filename="cursus-dispatch-plan-${plan.day}.json"`);
  return planToHandoffJson(plan, plan.day);
});

/* Live re-evaluation of one vehicle trip under a proposed stop order, WITHOUT a
 * re-solve. The browser lacks the N^2 travel matrix and the (confidential) tariff,
 * so it posts the proposed order here and gets back the recomputed trip (times,
 * distance, cost) for an honest reorder preview. See plan/evaluate.ts. */
app.post<{ Params: { id: string }; Body: { vehicleId?: number; tripIndex?: number; startSec?: number; reloadSecAfter?: number; orderNos?: unknown } }>(
  '/api/plans/:id/evaluate', async (req, reply) => {
    const plan = store.getPlan(req.params.id);
    if (!plan) return reply.code(404).send({ error: 'plan not found' });
    const b = req.body ?? {};
    if (typeof b.vehicleId !== 'number') return reply.code(400).send({ error: 'vehicleId required' });
    if (!Array.isArray(b.orderNos) || b.orderNos.length === 0 || b.orderNos.length > 500 || !b.orderNos.every((o) => typeof o === 'string'))
      return reply.code(400).send({ error: 'orderNos must be a non-empty string[] (<=500)' });
    const vehicle = plan.vehicles.find((v) => v.id === b.vehicleId);
    if (!vehicle) return reply.code(404).send({ error: 'vehicle not in plan' });
    const tripIndex = typeof b.tripIndex === 'number' ? b.tripIndex : 0;
    const srcTrip = vehicle.trips.find((tr) => tr.index === tripIndex) ?? vehicle.trips[0];
    // the proposed order must be a permutation of the trip's existing orders
    const have = new Set((srcTrip?.stops ?? []).map((s) => s.orderNo));
    const want = b.orderNos as string[];
    if (!srcTrip || want.length !== have.size || !want.every((o) => have.has(o)))
      return reply.code(400).send({ error: 'orderNos must be a permutation of the trip stops' });
    // plan.day is the ISO date; loadDay wants the day id (builtin or uploaded).
    const dayId = allDayIds().find((d) => d.isoDate === plan.day)?.id;
    if (!dayId) return reply.code(404).send({ error: 'day not found for plan' });
    const day = loadDay(dayId);
    const trip = evaluateTrip({
      day, request: day.request, vehicleId: b.vehicleId, tripIndex: srcTrip.index,
      startSec: typeof b.startSec === 'number' ? b.startSec : srcTrip.startSec,
      tripCountOnVehicle: vehicle.trips.length,
      reloadSecAfter: typeof b.reloadSecAfter === 'number' ? b.reloadSecAfter : srcTrip.reloadSecAfter,
      orderNos: want, vehicleInfo,
    });
    return { trip };
  },
);

app.get<{ Querystring: { base?: string; revised?: string } }>('/api/compare', async (req, reply) => {
  const base = req.query.base ? store.getPlan(req.query.base) : undefined;
  const revised = req.query.revised ? store.getPlan(req.query.revised) : undefined;
  if (!base || !revised) return reply.code(404).send({ error: 'base and revised plan ids required' });
  return comparePlans(base, revised);
});

/* ---- Week roll-up across both days' baselines (stats + cost, no geometry) ---- */
app.get('/api/week', async () => {
  const days = DAYS
    .map((d) => ({ dayId: d.id, isoDate: d.isoDate, label: d.label, plan: store.getPlan(`${d.id}-baseline`) }))
    .filter((d): d is { dayId: string; isoDate: string; label: string; plan: Plan } => Boolean(d.plan));
  return weekSummary(days);
});

/* ---- Sage narration (optional LLM; degrades gracefully) ---- */
app.get('/api/sage/status', async () => ({ reachable: await sageReachable(), model: config.sageModel }));

app.post<{ Params: { id: string }; Body: { lang?: Lang } }>('/api/plans/:id/narrate', async (req, reply) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) return reply.code(404).send({ error: 'plan not found' });
  try {
    return { text: await narratePlan(plan, req.body?.lang === 'hu' ? 'hu' : 'en') };
  } catch (e) {
    return reply.code(503).send({ error: `sage unavailable: ${(e as Error).message}`, unavailable: true });
  }
});

app.post<{ Querystring: { base?: string; revised?: string }; Body: { lang?: Lang } }>('/api/compare/narrate', async (req, reply) => {
  const base = req.query.base ? store.getPlan(req.query.base) : undefined;
  const revised = req.query.revised ? store.getPlan(req.query.revised) : undefined;
  if (!base || !revised) return reply.code(404).send({ error: 'base and revised plan ids required' });
  try {
    return { text: await narrateComparison(comparePlans(base, revised), req.body?.lang === 'hu' ? 'hu' : 'en') };
  } catch (e) {
    return reply.code(503).send({ error: `sage unavailable: ${(e as Error).message}`, unavailable: true });
  }
});

/* ---- Import / provenance (dedicated import view) ---- */
app.get('/api/import/summary', async () => importSummary());
app.get<{ Querystring: { file?: string; limit?: string } }>('/api/import/raw', async (req, reply) => {
  const s = rawSample(req.query.file ?? 'orders', req.query.limit ? Number(req.query.limit) : 8);
  if (!s) return reply.code(404).send({ error: 'raw file not available' });
  return s;
});
app.get<{ Querystring: { limit?: string } }>('/api/import/canonical', async (req, reply) => {
  const s = canonicalSample(req.query.limit ? Number(req.query.limit) : 8);
  if (!s) return reply.code(404).send({ error: 'canonical not available' });
  return s;
});

/* ---- Data onboarding (M1: upload CSV -> map columns -> reconcile preview) ---- */
// The canonical field catalog the mapping UI maps raw columns to.
app.get('/api/import/catalog', async () => CATALOG);

// Upload a raw CSV for an entity; store it, return headers + sample + a suggested mapping.
app.post<{ Querystring: { entity?: string } }>('/api/import/upload', async (req, reply) => {
  const entity = req.query.entity as Entity;
  if (!ENTITIES.includes(entity)) return reply.code(400).send({ error: 'unknown entity (orders|vehicles|routes)' });
  const data = await req.file();
  if (!data) return reply.code(400).send({ error: 'no file' });
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const ext = extFromName(data.filename) ?? (data.mimetype === 'text/csv' ? 'csv' : data.mimetype === XLSX_MIME ? 'xlsx' : null);
  if (!ext) return reply.code(400).send({ error: 'unsupported file type (CSV or XLSX only)' });

  const { uploadId, path } = newUploadPath(entity, ext);
  try {
    await pipeline(data.file, createWriteStream(path));
  } catch (e) {
    try { rmSync(path, { force: true }); } catch { /* ignore */ }
    return reply.code(500).send({ error: `upload failed: ${(e as Error).message}` });
  }
  if (data.file.truncated) { try { rmSync(path, { force: true }); } catch { /* ignore */ } return reply.code(413).send({ error: `file exceeds ${config.maxUploadMB} MB` }); }

  try {
    const sample = await sampleUpload(path, 8);
    if (sample.totalRows > config.maxUploadRows) { rmSync(path, { force: true }); return reply.code(413).send({ error: `too many rows (> ${config.maxUploadRows})` }); }
    return { uploadId, entity, headers: sample.headers, rows: sample.rows, totalRows: sample.totalRows, delimiter: sample.delimiter, suggested: suggestMapping(entity, sample.headers) };
  } catch (e) {
    try { rmSync(path, { force: true }); } catch { /* ignore */ }
    return reply.code(400).send({ error: `could not read file: ${(e as Error).message}` });
  }
});

// Dry-run: run the real Nexus ingest + reconcile gate on the mapped upload.
app.post<{ Body: { uploadId?: string; entity?: string; mapping?: Mapping } }>('/api/import/preview', async (req, reply) => {
  const { uploadId, entity, mapping } = req.body ?? {};
  if (!uploadId || !/^up_[a-z0-9-]+$/.test(uploadId)) return reply.code(400).send({ error: 'valid uploadId required' });
  if (!ENTITIES.includes(entity as Entity)) return reply.code(400).send({ error: 'unknown entity' });
  if (!mapping || typeof mapping !== 'object') return reply.code(400).send({ error: 'mapping required' });
  const path = uploadPath(uploadId, entity as Entity);
  if (!existsSync(path)) return reply.code(404).send({ error: 'upload not found (re-upload)' });
  return runIngestPreview(path, entity as Entity, mapping);
});

// Geocode the mapped orders (cache-first; keys-if-present else offline) -> tiers + points.
app.post<{ Body: { uploadId?: string; mapping?: Mapping } }>('/api/import/geocode', async (req, reply) => {
  const { uploadId, mapping } = req.body ?? {};
  if (!uploadId || !/^up_[a-z0-9-]+$/.test(uploadId)) return reply.code(400).send({ error: 'valid uploadId required' });
  if (!mapping || typeof mapping !== 'object') return reply.code(400).send({ error: 'mapping required' });
  const path = uploadPath(uploadId, 'orders');
  if (!existsSync(path)) return reply.code(404).send({ error: 'upload not found (re-upload)' });
  return runGeocode(path, mapping);
});

// Admit: geocode + build the travel matrix + Surge request, register the days.
app.post<{ Body: { uploadId?: string; mapping?: Mapping; label?: string; vehiclesUploadId?: string; vehiclesMapping?: Mapping } }>('/api/import/admit', async (req, reply) => {
  const { uploadId, mapping, label, vehiclesUploadId, vehiclesMapping } = req.body ?? {};
  if (!uploadId || !/^up_[a-z0-9-]+$/.test(uploadId)) return reply.code(400).send({ error: 'valid uploadId required' });
  if (!mapping || typeof mapping !== 'object') return reply.code(400).send({ error: 'mapping required' });
  if (label != null && (typeof label !== 'string' || label.length > 120)) return reply.code(400).send({ error: 'invalid label' });
  const path = uploadPath(uploadId, 'orders');
  if (!existsSync(path)) return reply.code(404).send({ error: 'upload not found (re-upload)' });

  // Optional custom fleet from an uploaded vehicles file.
  let fleetSource: { path: string; mapping: Mapping } | undefined;
  if (vehiclesUploadId != null) {
    if (!/^up_[a-z0-9-]+$/.test(vehiclesUploadId)) return reply.code(400).send({ error: 'valid vehiclesUploadId required' });
    if (!vehiclesMapping || typeof vehiclesMapping !== 'object') return reply.code(400).send({ error: 'vehiclesMapping required' });
    const vpath = uploadPath(vehiclesUploadId, 'vehicles');
    if (!existsSync(vpath)) return reply.code(404).send({ error: 'vehicles upload not found (re-upload)' });
    fleetSource = { path: vpath, mapping: vehiclesMapping };
  }

  // Admit runs in the background (geocode + matrix can take ~1 min); the client
  // polls /api/jobs/:id for the stage and the result.
  const job = store.createImportJob();
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.stage = 'queued';           // may wait for an import slot before geocoding
  store.saveJob(job);
  const t0 = Date.now();
  void (async () => {
    const release = await importSem.acquire();   // bound concurrent heavy admits
    try {
      const result = await admitDataset(path, mapping, label ?? 'Uploaded dataset', (stage) => { job.stage = stage; store.saveJob(job); }, fleetSource);
      job.elapsedSec = (Date.now() - t0) / 1000;
      job.finishedAt = new Date().toISOString();
      if (!result.ok) { job.status = 'failed'; job.error = result.error ?? 'admit failed'; store.saveJob(job); return; }
      for (const d of result.days ?? []) {
        try { buildBaseline(d.dayId, d.label); } catch (e) { app.log.warn(`baseline ${d.dayId}: ${(e as Error).message}`); }
      }
      job.status = 'completed'; job.result = result; store.saveJob(job);
    } catch (e) {
      job.status = 'failed'; job.error = (e as Error).message; job.finishedAt = new Date().toISOString();
      job.elapsedSec = (Date.now() - t0) / 1000; store.saveJob(job);
    } finally {
      release();
    }
  })();
  return reply.code(202).send({ jobId: job.id });
});

// List / delete admitted datasets.
app.get('/api/import/datasets', async () => allDatasets().map((d) => ({
  id: d.id, label: d.label, createdAt: d.createdAt,
  days: d.days.map((x) => ({ dayId: x.dayId, isoDate: x.isoDate, orders: x.orders })),
  totalOrders: d.days.reduce((n, x) => n + x.orders, 0),
})));
app.delete<{ Params: { id: string } }>('/api/import/datasets/:id', async (req, reply) => {
  if (!/^ds_[a-z0-9-]+$/.test(req.params.id)) return reply.code(400).send({ error: 'invalid dataset id' });
  const ds = unregisterDataset(req.params.id);
  if (!ds) return reply.code(404).send({ error: 'dataset not found' });
  for (const d of ds.days) store.removeDay(d.dayId);
  return { deleted: true, days: ds.days.length };
});

/* ---- Carta tile proxy (same-origin so the reused style's relative URLs work) ---- */
// Only forward the known tile shapes, path-only (drop any client query), so the
// proxy can't be used as a general relay to the internal Carta origin.
const TILE_PATH = /^\/tiles\/\d{1,2}\/\d{1,7}\/\d{1,7}(?:\.[a-z0-9]{1,8})?$/i;
async function proxyCarta(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = req.url.split('?')[0]!;
  if (path !== '/tiles.vector.json' && !TILE_PATH.test(path)) { reply.code(400).send({ error: 'bad tile path' }); return; }
  const target = config.cartaOrigin + path;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(15000) });
    reply.code(res.status);
    for (const h of ['content-type', 'cache-control', 'etag', 'access-control-allow-origin']) {
      const v = res.headers.get(h); if (v) reply.header(h, v);
    }
    reply.send(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    reply.code(502).send({ error: `carta proxy failed: ${(e as Error).message}` });
  }
}
app.get('/tiles.vector.json', proxyCarta);
app.get('/tiles/*', proxyCarta);

/* ---- Static SPA (production: backend serves the built frontend) ---- */
const webDist = config.webDist;
if (existsSync(join(webDist, 'index.html'))) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    // SPA fallback for GET navigations only; everything else is a real 404.
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/tiles') && !req.url.startsWith('/fonts')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });
  app.log.info(`serving SPA from ${webDist}`);
} else {
  app.log.info('no web build found; run the frontend via Vite in dev');
}

/* A5: refuse to expose an unauthenticated API on a public interface. There is
 * no auth layer yet, so binding to a non-loopback host without an auth token
 * configured would publish destructive + subprocess-spawning endpoints to the
 * network. Fail fast with a clear message rather than quietly doing that. */
function isLoopbackHost(h: string): boolean {
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}
const start = async () => {
  // A11: report (and under strict mode, refuse to start on) missing external
  // dependency paths, naming the env var and the feature each blocks.
  const missing = missingConfigPaths();
  for (const m of missing) app.log.warn(`config: ${m.variable} not found at ${m.path} -- ${m.feature} will fail until set`);
  if (missing.length && config.strictConfig) {
    app.log.error(`strict config: ${missing.length} required path(s) missing (see warnings); set the env vars or unset DISPATCH_STRICT_CONFIG`);
    process.exit(1);
  }
  if (!isLoopbackHost(config.host) && !config.authToken && !config.authRequired) {
    app.log.error(`refusing to bind ${config.host} without authentication, or bind 127.0.0.1 behind a trusted proxy`);
    process.exit(1);
  }
  try { await app.listen({ port: config.port, host: config.host }); }
  catch (err) { app.log.error(err); process.exit(1); }
};

// Bind a port only when run as the entry point; tests import `app` and use
// app.inject() without listening (set DISPATCH_NO_LISTEN=1).
if (process.env.DISPATCH_NO_LISTEN !== '1') start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'graceful shutdown');
  shutdownSolves();
  auth?.close();
  try { await app.close(); process.exit(0); }
  catch (err) { app.log.error({ err }, 'shutdown failed'); process.exit(1); }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { app };
