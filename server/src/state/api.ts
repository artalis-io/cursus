import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { StatefulStore } from './postgres.js';
import { ScenarioRepository } from './scenarios.js';
import { validateScenarioEdit, type ScenarioEdit } from '../store.js';
import { cookieValue } from '../auth.js';
import type { StatefulAuthService } from './auth.js';
import type { ObjectStore, ImmutableObject } from './objects.js';
import { DatasetRepository } from './datasets.js';
import fastifyMultipart from '@fastify/multipart';
import { exportScenario, parseScenarioImport } from '../store.js';
import { planToCsv, planToRouteSheetHtml, planToRoutesCsv, planToHandoffJson } from '../export.js';
import type { ConversionPayload } from './conversion.js';
import type { Mapping } from '../data/onboard.js';
import { magicLinkConfirmation, registerMagicLinkFormParser } from '../magic-link.js';
import type { Plan } from '../types.js';
import type { Scenario } from '../store.js';

export interface StatefulApiOptions { store: StatefulStore; tenantId: string; tenantName: string; auth?: StatefulAuthService; publicOrigin?: string; objects?: ObjectStore; maxUploadBytes?: number }

/** Stateful HTTP surface used by the runtime integration tests and, after
 * cutover, by the production entry point. Every repository is tenant-bound. */
export async function createStatefulApi(options: StatefulApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerMagicLinkFormParser(app);
  await options.store.ensureTenant(options.tenantId, options.tenantName);
  await options.auth?.initialize();
  const scenarios = new ScenarioRepository(options.store, options.tenantId);
  const datasets = options.objects ? new DatasetRepository(options.store, options.objects, options.tenantId) : null;
  if (datasets) await app.register(fastifyMultipart, { limits: { files: 1, fileSize: options.maxUploadBytes ?? 25 * 1024 * 1024 } });
  app.addHook('onRequest', async (req, reply) => {
    // The SPA shell and its static assets must remain public so an
    // unauthenticated browser can render the magic-link login screen.
    const path = req.url.split('?', 1)[0]!;
    if (!options.auth || !path.startsWith('/api/') || path.startsWith('/api/health') || path.startsWith('/api/auth/')) return;
    const principal = await options.auth.authenticate(cookieValue(req.headers.cookie, 'cursus_session'));
    if (!principal || principal.tenantId !== options.tenantId) return reply.code(401).send({ error: 'authentication required' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== options.publicOrigin)
      return reply.code(403).send({ error: 'invalid request origin' });
  });
  app.get('/api/health', async () => ({ status: 'ok', service: 'cursus-api', runtime: 'stateful' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await options.store.pool.query('SELECT 1');
      await options.objects?.ready();
      // Keep the literal spacing compatible with the adopted Cloudflare
      // monitor's expected-body fragment: `"status": "ready"`.
      return reply.type('application/json').send('{"status": "ready", "service": "cursus-api", "runtime": "stateful"}');
    } catch {
      return reply.code(503).send({ status: 'not-ready', service: 'cursus-api', runtime: 'stateful' });
    }
  });
  app.post<{ Body: { email?: string } }>('/api/auth/magic-link', async (req, reply) => {
    if (options.auth && typeof req.body?.email === 'string') await options.auth.requestMagicLink(req.body.email);
    return reply.code(202).send({ accepted: true });
  });
  app.get<{ Querystring: { token?: string } }>('/api/auth/verify', async (req, reply) => {
    if (!options.auth || !req.query.token) return reply.redirect('/?auth=invalid');
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8')
      .send(magicLinkConfirmation(req.query.token));
  });
  app.post<{ Querystring: { token?: string } }>('/api/auth/verify', async (req, reply) => {
    const session = options.auth && req.query.token ? await options.auth.consumeMagicLink(req.query.token) : null;
    if (!session) return reply.redirect('/?auth=invalid');
    reply.header('Set-Cookie', options.auth!.cookie(session)); return reply.redirect('/');
  });
  app.get('/api/auth/me', async (req, reply) => {
    if (!options.auth) return { email: 'local@cursus', tenantId: options.tenantId, role: 'admin' };
    return (await options.auth.authenticate(cookieValue(req.headers.cookie, 'cursus_session'))) ?? reply.code(401).send({ error: 'authentication required' });
  });
  app.post('/api/auth/logout', async (req, reply) => {
    if (options.auth && req.headers.origin !== options.publicOrigin) return reply.code(403).send({ error: 'invalid request origin' });
    await options.auth?.logout(cookieValue(req.headers.cookie, 'cursus_session'));
    if (options.auth) reply.header('Set-Cookie', options.auth.clearCookie()); return { ok: true };
  });
  app.get('/api/days', async () => statefulDaySummaries(
    await scenarios.list(), await options.store.listPlans(options.tenantId),
  ));
  app.get<{ Querystring: { day?: string } }>('/api/scenarios', async (req) => scenarios.list(req.query.day));
  app.post<{ Body: { day?: string; from?: string; label?: string } }>('/api/scenarios', async (req, reply) => {
    if (req.body?.from) { const parent = await scenarios.get(req.body.from); if (!parent) return reply.code(404).send({ error: 'parent scenario not found' }); return reply.code(201).send(await scenarios.copy(parent, req.body.label)); }
    if (req.body?.day) return scenarios.ensureBase(req.body.day, req.body.label ?? req.body.day);
    return reply.code(400).send({ error: 'day or from required' });
  });
  app.get<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => (await scenarios.get(req.params.id)) ?? reply.code(404).send({ error: 'scenario not found' }));
  app.post<{ Params: { id: string }; Body: { edit?: ScenarioEdit } }>('/api/scenarios/:id/edit', async (req, reply) => {
    const invalid = validateScenarioEdit(req.body?.edit); if (invalid) return reply.code(400).send({ error: invalid });
    try { return await scenarios.edit(req.params.id, [req.body.edit!]); } catch (error) { return reply.code((error as Error).message === 'scenario not found' ? 404 : 409).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { id: string }; Body: { label?: string } }>('/api/scenarios/:id/rename', async (req, reply) => {
    const label = req.body?.label?.trim(); if (!label || label.length > 120) return reply.code(400).send({ error: 'label required (<=120 chars)' });
    try { return await scenarios.rename(req.params.id, label); } catch { return reply.code(404).send({ error: 'scenario not found' }); }
  });
  app.delete<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
    const scenario = await scenarios.get(req.params.id); if (!scenario) return reply.code(404).send({ error: 'scenario not found' });
    if (scenario.kind === 'base') return reply.code(400).send({ error: 'base scenario cannot be deleted' });
    return { deleted: await scenarios.delete(req.params.id) };
  });
  app.get<{ Params: { id: string } }>('/api/scenarios/:id/export', async (req, reply) => {
    const scenario = await scenarios.get(req.params.id); return scenario ? exportScenario(scenario) : reply.code(404).send({ error: 'scenario not found' });
  });
  app.post('/api/scenarios/import', async (req, reply) => {
    const parsed = parseScenarioImport(req.body); if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const base = await scenarios.get(`${parsed.day}-base`); if (!base) return reply.code(400).send({ error: `unknown day '${parsed.day}' (admit its dataset first)` });
    return scenarios.import(base, parsed.label, parsed.edits);
  });
  app.post<{ Params: { id: string }; Body: { budgetSec?: number; objective?: string } }>('/api/scenarios/:id/solve', async (req, reply) => {
    const scenario = await scenarios.get(req.params.id); if (!scenario) return reply.code(404).send({ error: 'scenario not found' });
    const id = await options.store.enqueueJob(options.tenantId, 'solve', `solve/${scenario.id}/${scenario.revision}/${randomKey()}`, {
      scenarioId: scenario.id, scenarioRevision: scenario.revision, budgetSec: req.body?.budgetSec, objective: req.body?.objective ?? 'vehicles', scenario,
    });
    return reply.code(202).send({ jobId: id, status: 'pending', scenarioId: scenario.id, scenarioRevision: scenario.revision });
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = await options.store.getJob(options.tenantId, req.params.id);
    return job ? statefulJobResponse(job) : reply.code(404).send({ error: 'job not found' });
  });
  app.get<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => (await options.store.getPlan(options.tenantId, req.params.id)) ?? reply.code(404).send({ error: 'plan not found' }));
  app.get('/api/plans', async () => options.store.listPlans(options.tenantId));
  const planExport = (kind: 'csv' | 'routes' | 'html' | 'handoff') => async (req: { params: { id: string } }, reply: FastifyReply) => {
    const plan = await options.store.getPlan(options.tenantId, req.params.id); if (!plan) return reply.code(404).send({ error: 'plan not found' });
    if (kind === 'csv') { reply.type('text/csv; charset=utf-8'); return reply.send(planToCsv(plan)); }
    if (kind === 'routes') { reply.type('text/csv; charset=utf-8'); return reply.send(planToRoutesCsv(plan, plan.day)); }
    if (kind === 'html') { reply.type('text/html; charset=utf-8'); return reply.send(planToRouteSheetHtml(plan, plan.day)); }
    return planToHandoffJson(plan, plan.day);
  };
  app.get<{ Params: { id: string } }>('/api/plans/:id/export.csv', planExport('csv'));
  app.get<{ Params: { id: string } }>('/api/plans/:id/routes.csv', planExport('routes'));
  app.get<{ Params: { id: string } }>('/api/plans/:id/routesheet.html', planExport('html'));
  app.get<{ Params: { id: string } }>('/api/plans/:id/handoff.json', planExport('handoff'));
  app.post('/api/import/upload', async (req, reply) => {
    if (!datasets) return reply.code(503).send({ error: 'object storage not configured' });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: 'no file' });
    const bytes = await file.toBuffer(); if (!bytes.length) return reply.code(400).send({ error: 'empty file' });
    return reply.code(201).send(await datasets.upload(bytes, file.mimetype, file.filename));
  });
  app.post<{ Params: { id: string } }>('/api/import/datasets/:id/validate', async (req, reply) => {
    if (!datasets) return reply.code(503).send({ error: 'object storage not configured' });
    try { return await datasets.validate(req.params.id); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/api/import/datasets/:id/admit', async (req, reply) => {
    if (!datasets) return reply.code(503).send({ error: 'object storage not configured' });
    try { return await datasets.admit(req.params.id); } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { id: string }; Body: { mapping?: Mapping; label?: string } }>('/api/import/datasets/:id/convert', async (req, reply) => {
    if (!datasets) return reply.code(503).send({ error: 'object storage not configured' });
    const dataset = await datasets.get(req.params.id); if (!dataset) return reply.code(404).send({ error: 'dataset not found' });
    if (!req.body?.mapping || typeof req.body.mapping !== 'object') return reply.code(400).send({ error: 'mapping required' });
    const manifest = dataset.manifest as { source?: ImmutableObject; name?: string };
    if (!manifest.source) return reply.code(409).send({ error: 'dataset source missing' });
    const payload: ConversionPayload = { datasetId: req.params.id, source: manifest.source,
      sourceName: manifest.name ?? 'upload.csv', mapping: req.body.mapping, label: req.body.label ?? manifest.name ?? 'Uploaded dataset' };
    const { conversionIdentity } = await import('./conversion.js');
    const identity = await conversionIdentity(payload);
    const jobId = await options.store.enqueueJob(options.tenantId, 'dataset-admit', `convert/${identity.fingerprint}`, payload);
    return reply.code(202).send({ jobId, datasetId: req.params.id, conversionFingerprint: identity.fingerprint });
  });
  app.get('/api/import/datasets', async (_req, reply) => datasets ? datasets.list() : reply.code(503).send({ error: 'object storage not configured' }));
  return app;
}

function randomKey(): string { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

/** Adapt authoritative state to the stable SPA contract. Only days with a
 * published plan are selectable; an admitted but unsolved day would otherwise
 * lead the user directly to a 404. */
export function statefulDaySummaries(scenarios: Scenario[], plans: Plan[]) {
  return scenarios
    .filter((scenario) => scenario.kind === 'base')
    .map((scenario) => {
      const plan = plans
        .filter((candidate) => candidate.scenarioId === scenario.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!plan) return null;
      return {
        id: scenario.day,
        isoDate: plan.day,
        label: scenario.label,
        datasetLabel: null,
        orders: plan.stats.totalOrders,
        vehicles: plan.vehicles.length,
        baseScenarioId: scenario.id,
        baselinePlanId: plan.id,
      };
    })
    .filter((day): day is NonNullable<typeof day> => day !== null);
}

export function statefulJobResponse(job: Record<string, unknown>) {
  const result = job.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : {};
  const payload = job.payload && typeof job.payload === 'object' ? job.payload as Record<string, unknown> : {};
  const state = String(job.state ?? 'pending');
  const status = state === 'succeeded' ? 'completed' : state;
  const createdAt = new Date(String(job.createdAt));
  const updatedAt = new Date(String(job.updatedAt));
  return {
    ...job,
    status,
    scenarioId: payload.scenarioId ?? null,
    scenarioRevision: payload.scenarioRevision ?? null,
    elapsedSec: Number.isFinite(createdAt.valueOf()) && Number.isFinite(updatedAt.valueOf())
      ? Math.max(0, (updatedAt.valueOf() - createdAt.valueOf()) / 1000) : 0,
    planId: result.planId ?? null,
    termination: result.termination ?? null,
  };
}
