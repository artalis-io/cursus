import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { JobQueueFullError, RevisionConflictError, type StatefulStore } from './postgres.js';
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
import { magicLinkConfirmation, magicLinkLanguage, registerMagicLinkFormParser } from '../magic-link.js';
import { registerWorkspaceBranding } from '../workspace-branding.js';
import type { Plan } from '../types.js';
import type { Scenario } from '../store.js';
import { config } from '../config.js';
import { buildInfo } from '../build-info.js';
import { fillPlanGeometry } from '../geometry/velo.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG, suggestMapping, type Entity } from '../data/catalog.js';
import { extFromName, runGeocode, runIngestPreview, sampleUpload } from '../data/onboard.js';
import { weekSummary } from '../plan/week.js';
import { comparePlans } from '../plan/compare.js';
import { evaluateTrip } from '../plan/evaluate.js';
import { loadDay, loadVehicleInfo } from '../data/dataset.js';
import { loadConvertedDay, type ConvertedManifest } from './conversion.js';
import { registerAccessControl, viewIdentity } from '../access-control.js';
import { isRole, rolePermissions } from '../roles.js';
import { expectedRevision, registerScenarioPreconditions } from '../revisions.js';
import { PlanWorkflow, WorkflowError } from './plan-workflow.js';
import { exportFilename } from '../handoff.js';

// Do not advertise legacy-only endpoints as usable controls in this runtime.
function statefulPermissions(role: string) {
  return isRole(role) ? rolePermissions[role].filter(p => p !== 'optimization.cancel' && p !== 'analysis.generate' && p !== 'dataset.delete') : [];
}

export interface StatefulApiOptions { store: StatefulStore; tenantId: string; tenantName: string; auth?: StatefulAuthService; publicOrigin?: string; objects?: ObjectStore; maxUploadBytes?: number }

/** Stateful HTTP surface used by the runtime integration tests and, after
 * cutover, by the production entry point. Every repository is tenant-bound. */
export async function createStatefulApi(options: StatefulApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerAccessControl(app, options.auth ? { authenticate: token => options.auth!.authenticate(token),
    audit: (principal, detail) => options.auth!.recordAccessAudit(principal, detail),
    tenantId: options.tenantId, publicOrigin: options.publicOrigin ?? '' } : undefined);
  registerMagicLinkFormParser(app);
  registerWorkspaceBranding(app, options.tenantName);
  await options.store.ensureTenant(options.tenantId, options.tenantName);
  await options.auth?.initialize();
  const scenarios = new ScenarioRepository(options.store, options.tenantId);
  registerScenarioPreconditions(app, id => scenarios.get(id));
  const workflow = new PlanWorkflow(options.store, options.tenantId);
  app.get<{ Params: { id: string } }>('/api/plans/:id/workflow', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try { return await workflow.get(req.params.id); }
    catch (error) { if (error instanceof WorkflowError) return reply.code(error.status).send({ error: error.message }); throw error; }
  });
  for (const action of ['review', 'approve'] as const) {
    app.post<{ Params: { id: string }; Body: { version?: unknown; revision?: unknown; acknowledgeExceptions?: unknown } }>(`/api/plans/:id/${action}`, async (req, reply) => {
      const body = req.body;
      if (!Number.isSafeInteger(body?.version) || Number(body.version) < 0 || !Number.isSafeInteger(body?.revision) || Number(body.revision) < 0)
        return reply.code(400).send({ error: 'Non-negative version and revision required.' });
      try { return await workflow.transition(req.params.id, `plan.${action}`, Number(body.version), Number(body.revision), body.acknowledgeExceptions === true, req.cursusPrincipal); }
      catch (error) { if (error instanceof WorkflowError) return reply.code(error.status).send({ error: error.message }); throw error; }
    });
  }
  const datasets = options.objects ? new DatasetRepository(options.store, options.objects, options.tenantId) : null;
  if (datasets) await app.register(fastifyMultipart, { limits: { files: 1, fileSize: options.maxUploadBytes ?? 25 * 1024 * 1024 } });
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
  app.get<{ Querystring: { token?: string; lang?: string } }>('/api/auth/verify', async (req, reply) => {
    if (!options.auth || !req.query.token) return reply.redirect('/?auth=invalid');
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8')
      .send(magicLinkConfirmation(req.query.token, options.tenantName, magicLinkLanguage(req.query.lang, req.headers['accept-language'])));
  });
  app.post<{ Querystring: { token?: string } }>('/api/auth/verify', async (req, reply) => {
    const session = options.auth && req.query.token ? await options.auth.consumeMagicLink(req.query.token) : null;
    if (!session) return reply.redirect('/?auth=invalid');
    reply.header('Set-Cookie', options.auth!.cookie(session)); return reply.redirect('/');
  });
  app.get('/api/auth/me', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!options.auth) return { email: 'local@cursus', tenantId: options.tenantId, tenantName: options.tenantName, role: 'admin', permissions: statefulPermissions('admin').filter(p => p !== 'role.preview'), build: buildInfo };
    const principal = await options.auth.authenticate(cookieValue(req.headers.cookie, 'cursus_session'));
    if (!principal || principal.tenantId !== options.tenantId) return reply.code(401).send({ error: 'authentication required' });
    const identity = viewIdentity(principal, req.headers.cookie);
    return { ...identity, permissions: statefulPermissions(identity.effectiveRole), tenantName: await options.store.getTenantName(principal.tenantId), build: buildInfo };
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
    try { return await scenarios.edit(req.params.id, [req.body.edit!], expectedRevision(req.headers)!); } catch (error) { return reply.code((error as Error).message === 'scenario not found' ? 404 : 409).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { id: string }; Body: { edits?: unknown; label?: unknown } }>('/api/scenarios/:id/edits', async (req, reply) => {
    const edits = req.body?.edits;
    if (!Array.isArray(edits) || edits.length === 0 || edits.length > 1000)
      return reply.code(400).send({ error: 'edits must be a non-empty array (<=1000)' });
    // Validate the complete batch before copying a scenario or persisting any
    // operation. Unknown operations cannot smuggle administration into edits.
    for (const edit of edits) { const invalid = validateScenarioEdit(edit); if (invalid) return reply.code(400).send({ error: invalid }); }
    if (req.body.label != null && (typeof req.body.label !== 'string' || req.body.label.length > 120))
      return reply.code(400).send({ error: 'invalid label' });
    try { return await scenarios.edit(req.params.id, edits as ScenarioEdit[], expectedRevision(req.headers)!); }
    catch (error) { return reply.code((error as Error).message === 'scenario not found' ? 404 : 409).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { id: string }; Body: { label?: string } }>('/api/scenarios/:id/rename', async (req, reply) => {
    const label = req.body?.label?.trim(); if (!label || label.length > 120) return reply.code(400).send({ error: 'label required (<=120 chars)' });
    try { return await scenarios.rename(req.params.id, label, expectedRevision(req.headers)!); }
    catch (error) { return reply.code((error as Error).message === 'scenario not found' ? 404 : 409).send({ error: (error as Error).message }); }
  });
  app.delete<{ Params: { id: string } }>('/api/scenarios/:id', async (req, reply) => {
    const scenario = await scenarios.get(req.params.id); if (!scenario) return reply.code(404).send({ error: 'scenario not found' });
    if (scenario.kind === 'base') return reply.code(400).send({ error: 'base scenario cannot be deleted' });
    try { return { deleted: await scenarios.delete(req.params.id, expectedRevision(req.headers)!) }; }
    catch (error) { if (error instanceof RevisionConflictError) return reply.code(409).send({ error: 'Scenario changed; reload before deleting.' }); throw error; }
  });
  app.get<{ Params: { id: string } }>('/api/scenarios/:id/export', async (req, reply) => {
    const scenario = await scenarios.get(req.params.id); return scenario ? exportScenario(scenario) : reply.code(404).send({ error: 'scenario not found' });
  });
  app.post('/api/scenarios/import', async (req, reply) => {
    const parsed = parseScenarioImport(req.body); if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const base = await scenarios.get(`${parsed.day}-base`); if (!base) return reply.code(400).send({ error: `unknown day '${parsed.day}' (admit its dataset first)` });
    try { return await scenarios.import(base, parsed.label, parsed.edits); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.post<{ Params: { id: string }; Body: { budgetSec?: number; objective?: string; fullBudget?: boolean } }>('/api/scenarios/:id/solve', async (req, reply) => {
    const scenario = await scenarios.get(req.params.id); if (!scenario) return reply.code(404).send({ error: 'scenario not found' });
    if (scenario.revision !== expectedRevision(req.headers)) return reply.code(409).send({ error: 'Scenario changed; reload before optimizing.' });
    let id: string;
    try {
      id = await options.store.enqueueJob(options.tenantId, 'solve', `solve/${scenario.id}/${scenario.revision}/${randomKey()}`, {
        scenarioId: scenario.id, scenarioRevision: scenario.revision, budgetSec: req.body?.budgetSec, objective: req.body?.objective ?? 'vehicles', fullBudget: req.body?.fullBudget === true, scenario,
      }, config.maxSolveQueue, { id: scenario.id, revision: expectedRevision(req.headers)! });
    } catch (error) {
      if (error instanceof RevisionConflictError) return reply.code(409).send({ error: 'Scenario changed; reload before optimizing.' });
      if (error instanceof JobQueueFullError) return reply.code(429).send({ error: 'optimization queue is full; retry later' });
      throw error;
    }
    return reply.code(202).send({ jobId: id, status: 'pending', scenarioId: scenario.id, scenarioRevision: scenario.revision });
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = await options.store.getJob(options.tenantId, req.params.id);
    return job ? statefulJobResponse(job) : reply.code(404).send({ error: 'job not found' });
  });
  app.get<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => {
    const plan = await options.store.getPlan(options.tenantId, req.params.id);
    if (!plan) return reply.code(404).send({ error: 'plan not found' });
    await fillPlanGeometry(plan).catch(() => false);
    return plan;
  });
  app.post<{ Params: { id: string }; Body: { vehicleId?: number; tripIndex?: number; startSec?: number; reloadSecAfter?: number; orderNos?: unknown } }>(
    '/api/plans/:id/evaluate', async (req, reply) => {
      const plan = await options.store.getPlan(options.tenantId, req.params.id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const b = req.body ?? {};
      if (typeof b.vehicleId !== 'number') return reply.code(400).send({ error: 'vehicleId required' });
      if (!Array.isArray(b.orderNos) || b.orderNos.length === 0 || b.orderNos.length > 500 || !b.orderNos.every((o) => typeof o === 'string'))
        return reply.code(400).send({ error: 'orderNos must be a non-empty string[] (<=500)' });
      const vehicle = plan.vehicles.find((v) => v.id === b.vehicleId);
      if (!vehicle) return reply.code(404).send({ error: 'vehicle not in plan' });
      const srcTrip = vehicle.trips.find((tr) => tr.index === (b.tripIndex ?? 0)) ?? vehicle.trips[0];
      const have = new Set((srcTrip?.stops ?? []).map((s) => s.orderNo));
      const want = b.orderNos as string[];
      if (!srcTrip || want.length !== have.size || !want.every((o) => have.has(o)))
        return reply.code(400).send({ error: 'orderNos must be a permutation of the trip stops' });
      const scenario = await scenarios.get(plan.scenarioId);
      if (!scenario) return reply.code(404).send({ error: 'scenario not found for plan' });
      let day;
      if (options.objects) {
        const rows = await options.store.listDatasets(options.tenantId, true);
        const row = rows.find((candidate) => ((candidate.manifest as ConvertedManifest | undefined)?.days ?? []).some((d) => d.dayId === scenario.day) &&
          (!scenario.planningPolicy || (candidate.manifest as ConvertedManifest).artifacts?.request?.sha256 === scenario.planningPolicy.datasetRequestSha256));
        if (!row) return reply.code(404).send({ error: 'dataset not available for plan' });
        day = await loadConvertedDay(options.objects, options.tenantId, row.manifest as ConvertedManifest, scenario);
      } else { day = loadDay(scenario.day); }
      return { trip: evaluateTrip({ day, request: day.request, vehicleId: b.vehicleId, tripIndex: srcTrip.index,
        startSec: typeof b.startSec === 'number' ? b.startSec : srcTrip.startSec, tripCountOnVehicle: vehicle.trips.length,
        reloadSecAfter: typeof b.reloadSecAfter === 'number' ? b.reloadSecAfter : srcTrip.reloadSecAfter,
        orderNos: want, vehicleInfo: loadVehicleInfo() }) };
    },
  );
  app.get<{ Querystring: { day?: string } }>('/api/plans', async (req) => statefulPlanSummaries(
    await scenarios.list(), await options.store.listPlans(options.tenantId), req.query.day,
  ));
  app.get<{ Querystring: { base?: string; revised?: string } }>('/api/compare', async (req, reply) => {
    const [base, revised] = await Promise.all([
      req.query.base ? options.store.getPlan(options.tenantId, req.query.base) : undefined,
      req.query.revised ? options.store.getPlan(options.tenantId, req.query.revised) : undefined,
    ]);
    if (!base || !revised) return reply.code(404).send({ error: 'base and revised plan ids required' });
    return comparePlans(base, revised);
  });
  app.get('/api/week', async () => statefulWeekSummary(
    await scenarios.list(), await options.store.listPlans(options.tenantId),
  ));
  const planExport = (kind: 'csv' | 'routes' | 'html' | 'handoff') => async (req: { params: { id: string }; query: { approval?: string } }, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (req.query.approval !== undefined && req.query.approval !== 'required') return reply.code(400).send({ error: 'approval must be required or omitted' });
    try {
      const result = await workflow.renderExport(req.params.id, req.query.approval === 'required', (plan, metadata) => {
        if (kind === 'csv') return planToCsv(plan, metadata);
        if (kind === 'routes') return planToRoutesCsv(plan, plan.day, metadata);
        if (kind === 'html') return planToRouteSheetHtml(plan, plan.day, metadata);
        return JSON.stringify(planToHandoffJson(plan, plan.day, metadata));
      });
      reply.type(kind === 'html' ? 'text/html; charset=utf-8' : kind === 'handoff' ? 'application/json' : 'text/csv; charset=utf-8');
      reply.header('X-Cursus-Export-Status', result.metadata.status);
      reply.header('Content-Disposition', `${kind === 'html' ? 'inline' : 'attachment'}; filename="${exportFilename(req.params.id, result.metadata.status, kind === 'handoff' ? 'json' : kind === 'html' ? 'html' : `${kind}.csv`)}"`);
      return reply.send(result.body);
    } catch (error) { if (error instanceof WorkflowError) return reply.code(error.status).send({ error: error.message }); throw error; }
  };
  app.get<{ Params: { id: string }; Querystring: { approval?: string } }>('/api/plans/:id/export.csv', planExport('csv'));
  app.get<{ Params: { id: string }; Querystring: { approval?: string } }>('/api/plans/:id/routes.csv', planExport('routes'));
  app.get<{ Params: { id: string }; Querystring: { approval?: string } }>('/api/plans/:id/routesheet.html', planExport('html'));
  app.get<{ Params: { id: string }; Querystring: { approval?: string } }>('/api/plans/:id/handoff.json', planExport('handoff'));
  app.get('/api/import/catalog', async () => CATALOG);
  app.get('/api/import/summary', async () => statefulImportSummary(await options.store.listDatasets(options.tenantId, true)));
  app.get<{ Querystring: { file?: string; limit?: string } }>('/api/import/raw', async (req, reply) => {
    if (!datasets || !options.objects) return reply.code(503).send({ error: 'object storage not configured' });
    const dataset = await latestDataset(options.store, options.tenantId);
    const manifest = dataset?.manifest as StatefulDatasetManifest | undefined;
    const role = req.query.file ?? 'orders';
    const object = role === 'orders' ? manifest?.source : manifest?.rawInputs?.find((item) => item.role.includes(role));
    if (!object) return reply.code(404).send({ error: 'raw file not available' });
    try {
      const sample = await withObjectFile(options.objects, object, objectName(manifest, object), (path) => sampleUpload(path, safeLimit(req.query.limit)));
      return { label: role, ...sample };
    } catch (error) { return reply.code(400).send({ error: `could not read source: ${(error as Error).message}` }); }
  });
  app.get<{ Querystring: { limit?: string } }>('/api/import/canonical', async (req, reply) => {
    if (!options.objects) return reply.code(503).send({ error: 'object storage not configured' });
    const dataset = await latestDataset(options.store, options.tenantId);
    const manifest = dataset?.manifest as StatefulDatasetManifest | undefined;
    const object = manifest?.artifacts?.geocoded;
    if (!object) return reply.code(404).send({ error: 'canonical not available' });
    try {
      const bytes = await options.objects.getVerified(object);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>[] | { records?: Record<string, unknown>[] };
      const records = Array.isArray(parsed) ? parsed : parsed.records ?? [];
      const fields = records[0] ? Object.keys(records[0]) : [];
      return { fields, rows: records.slice(0, safeLimit(req.query.limit)), count: records.length, sha256: object.sha256 };
    } catch (error) { return reply.code(400).send({ error: `could not read canonical data: ${(error as Error).message}` }); }
  });
  app.post<{ Querystring: { entity?: string } }>('/api/import/upload', async (req, reply) => {
    if (!datasets) return reply.code(503).send({ error: 'object storage not configured' });
    const entity = req.query.entity as Entity | undefined;
    if (entity && !(['orders', 'vehicles', 'routes'] as string[]).includes(entity)) return reply.code(400).send({ error: 'unknown entity (orders|vehicles|routes)' });
    const file = await req.file(); if (!file) return reply.code(400).send({ error: 'no file' });
    const bytes = await file.toBuffer(); if (!bytes.length) return reply.code(400).send({ error: 'empty file' });
    // Keep the lower-level immutable JSON bundle API used by integrations;
    // browser onboarding always supplies an entity and takes the CSV/XLSX path.
    if (!entity) return reply.code(201).send(await datasets.upload(bytes, file.mimetype, file.filename));
    const ext = extFromName(file.filename); if (!ext) return reply.code(400).send({ error: 'unsupported file type (CSV or XLSX only)' });
    try {
      const sample = await withBytesFile(bytes, ext, (path) => sampleUpload(path, 8));
      const uploaded = await datasets.upload(bytes, file.mimetype, file.filename, { entity });
      return reply.code(201).send({ ...uploaded, uploadId: uploaded.datasetId, entity, ...sample, suggested: suggestMapping(entity, sample.headers) });
    } catch (error) { return reply.code(400).send({ error: `could not read file: ${(error as Error).message}` }); }
  });
  app.post<{ Body: { uploadId?: string; entity?: Entity; mapping?: Mapping } }>('/api/import/preview', async (req, reply) => {
    if (!datasets || !options.objects) return reply.code(503).send({ error: 'object storage not configured' });
    const { uploadId, entity, mapping } = req.body ?? {};
    if (!uploadId || !entity || !mapping) return reply.code(400).send({ error: 'uploadId, entity and mapping required' });
    const dataset = await datasets.get(uploadId); const manifest = dataset?.manifest as StatefulDatasetManifest | undefined;
    if (!manifest?.source || manifest.entity !== entity) return reply.code(404).send({ error: 'upload not found (re-upload)' });
    return withObjectFile(options.objects, manifest.source, objectName(manifest, manifest.source), (path) => runIngestPreview(path, entity, mapping));
  });
  app.post<{ Body: { uploadId?: string; mapping?: Mapping } }>('/api/import/geocode', async (req, reply) => {
    if (!datasets || !options.objects) return reply.code(503).send({ error: 'object storage not configured' });
    const { uploadId, mapping } = req.body ?? {};
    if (!uploadId || !mapping) return reply.code(400).send({ error: 'uploadId and mapping required' });
    const dataset = await datasets.get(uploadId); const manifest = dataset?.manifest as StatefulDatasetManifest | undefined;
    if (!manifest?.source || manifest.entity !== 'orders') return reply.code(404).send({ error: 'orders upload not found (re-upload)' });
    return withObjectFile(options.objects, manifest.source, objectName(manifest, manifest.source), (path) => runGeocode(path, mapping));
  });
  app.post<{ Body: { uploadId?: string; mapping?: Mapping; label?: string; vehiclesUploadId?: string; vehiclesMapping?: Mapping } }>('/api/import/admit', async (req, reply) => {
    if (!datasets) return reply.code(503).send({ error: 'object storage not configured' });
    const { uploadId, mapping, label, vehiclesUploadId, vehiclesMapping } = req.body ?? {};
    if (!uploadId || !mapping) return reply.code(400).send({ error: 'uploadId and mapping required' });
    const dataset = await datasets.get(uploadId); const manifest = dataset?.manifest as StatefulDatasetManifest | undefined;
    if (!manifest?.source || manifest.entity !== 'orders') return reply.code(404).send({ error: 'orders upload not found (re-upload)' });
    let fleet: ConversionPayload['fleet'];
    if (vehiclesUploadId) {
      const vehicles = await datasets.get(vehiclesUploadId); const vm = vehicles?.manifest as StatefulDatasetManifest | undefined;
      if (!vm?.source || vm.entity !== 'vehicles' || !vehiclesMapping) return reply.code(404).send({ error: 'vehicles upload not found (re-upload)' });
      fleet = { source: vm.source, sourceName: vm.name ?? 'vehicles.csv', mapping: vehiclesMapping };
    }
    const payload: ConversionPayload = { datasetId: uploadId, source: manifest.source, sourceName: manifest.name ?? 'upload.csv', mapping,
      label: label?.trim() || manifest.name || 'Uploaded dataset', ...(fleet ? { fleet } : {}) };
    const { conversionIdentity } = await import('./conversion.js'); const identity = await conversionIdentity(payload);
    const jobId = await options.store.enqueueJob(options.tenantId, 'dataset-admit', `convert/${identity.fingerprint}`, payload);
    return reply.code(202).send({ jobId });
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
  app.get('/api/import/datasets', async (_req, reply) => datasets ? (await datasets.list()).map(statefulDatasetSummary) : reply.code(503).send({ error: 'object storage not configured' }));
  const tilePath = /^\/tiles\/\d{1,2}\/\d{1,7}\/\d{1,7}(?:\.[a-z0-9]{1,8})?$/i;
  const proxyCarta = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?', 1)[0]!;
    if (path !== '/tiles.vector.json' && !tilePath.test(path)) return reply.code(400).send({ error: 'bad tile path' });
    try {
      const response = await fetch(config.cartaOrigin + path, { signal: AbortSignal.timeout(15_000) });
      reply.code(response.status);
      for (const header of ['content-type', 'cache-control', 'etag']) {
        const value = response.headers.get(header); if (value) reply.header(header, value);
      }
      return reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      return reply.code(502).send({ error: `carta proxy failed: ${(error as Error).message}` });
    }
  };
  app.get('/tiles.vector.json', proxyCarta);
  app.get('/tiles/*', proxyCarta);
  return app;
}

interface StatefulDatasetManifest { source?: ImmutableObject; name?: string; entity?: Entity; label?: string;
  rawInputs?: (ImmutableObject & { role: string })[]; artifacts?: { request?: ImmutableObject; geocoded?: ImmutableObject };
  days?: { dayId: string; isoDate: string; orders?: number }[]; stats?: { routable?: number; excluded?: number } }
const safeLimit = (value?: string) => Math.min(50, Math.max(1, Number(value) || 8));
async function latestDataset(store: StatefulStore, tenantId: string) { const all = await store.listDatasets(tenantId, true); return all.at(-1); }
function objectName(manifest: StatefulDatasetManifest | undefined, object: ImmutableObject) {
  return manifest?.name && extFromName(manifest.name) ? manifest.name : object.mediaType.includes('spreadsheet') ? 'upload.xlsx' : 'upload.csv';
}
async function withBytesFile<T>(bytes: Uint8Array, ext: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cursus-upload-')); const path = join(dir, `source.${ext}`);
  try { await writeFile(path, bytes, { mode: 0o600 }); return await fn(path); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function withObjectFile<T>(objects: ObjectStore, object: ImmutableObject, name: string, fn: (path: string) => Promise<T>): Promise<T> {
  return withBytesFile(await objects.getVerified(object), extFromName(name) ?? 'csv', fn);
}
export function statefulDatasetSummary(row: Record<string, unknown>) {
  const manifest = row.manifest as StatefulDatasetManifest; const days = manifest.days ?? [];
  return { id: String(row.id), label: manifest.label ?? manifest.name ?? String(row.id), createdAt: String(row.createdAt),
    days: days.map((d) => ({ dayId: d.dayId, isoDate: d.isoDate, orders: d.orders ?? 0 })),
    totalOrders: days.reduce((sum, d) => sum + (d.orders ?? 0), 0) || manifest.stats?.routable || 0 };
}
export function statefulImportSummary(rows: Record<string, unknown>[]) {
  const row = rows.at(-1); const manifest = row?.manifest as StatefulDatasetManifest | undefined; const days = manifest?.days ?? [];
  const source = manifest?.source;
  return { sources: source ? [{ kind: 'orders', label: manifest?.label ?? manifest?.name ?? 'Orders', file: manifest?.name ?? 'immutable upload', present: true,
      sha256: source.sha256, rawRows: manifest?.stats?.routable ?? 0 }] : [],
    canonical: { orders: { count: manifest?.stats?.routable ?? null, sourceSha256: source?.sha256 ?? null, audit: null } },
    pipeline: [{ stage: 'Upload', detail: 'Checksum-addressed immutable object' }, { stage: 'Nexus', detail: 'Canonical validation and reconciliation' },
      { stage: 'Geocode + Velo', detail: 'Verified coordinates and road matrix' }, { stage: 'Admission', detail: 'Fenced PostgreSQL publication' }],
    rules: ['Only admitted immutable datasets are solver-visible.', 'Checksums and converter identities are retained with the dataset manifest.'],
    scope: { rawOrderLines: manifest?.stats?.routable ?? 0, inScopeHungarian: manifest?.stats?.routable ?? 0,
      day1: days[0]?.orders ?? 0, day2: days[1]?.orders ?? 0 } };
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
        .sort((a, b) => Number(b.source === 'saved') - Number(a.source === 'saved') || b.createdAt.localeCompare(a.createdAt))[0];
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

function preferredPlan(scenario: Scenario, plans: Plan[]): Plan | undefined {
  return plans
    .filter((candidate) => candidate.scenarioId === scenario.id)
    .sort((a, b) => Number(b.source === 'saved') - Number(a.source === 'saved') || b.createdAt.localeCompare(a.createdAt))[0];
}

/** Keep the stateful /api/plans response identical to the legacy SPA contract.
 * PostgreSQL stores full plans, but the history dialog consumes summaries. */
export function statefulPlanSummaries(scenarios: Scenario[], plans: Plan[], day?: string) {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return plans
    .filter((plan) => !day || byId.get(plan.scenarioId)?.day === day)
    .map((plan) => {
      const scenario = byId.get(plan.scenarioId);
      return {
        id: plan.id, scenarioId: plan.scenarioId, day: scenario?.day ?? null,
        label: scenario?.label ?? plan.scenarioId, source: plan.source, createdAt: plan.createdAt,
        termination: plan.provenance?.termination ?? 'UNKNOWN',
        servedOrders: plan.stats.servedOrders, totalOrders: plan.stats.totalOrders,
        vehiclesUsed: plan.stats.vehiclesUsed, totalDistanceKm: plan.stats.totalDistanceKm,
      };
    })
    .sort((a, b) => Number(a.source !== 'saved') - Number(b.source !== 'saved') || a.createdAt.localeCompare(b.createdAt));
}

/** Week view uses each base scenario's preferred saved plan, matching the day
 * selector and legacy runtime semantics. */
export function statefulWeekSummary(scenarios: Scenario[], plans: Plan[]) {
  return weekSummary(scenarios
    .filter((scenario) => scenario.kind === 'base')
    .map((scenario) => ({ scenario, plan: preferredPlan(scenario, plans) }))
    .filter((item): item is { scenario: Scenario; plan: Plan } => Boolean(item.plan))
    .map(({ scenario, plan }) => ({ dayId: scenario.day, isoDate: plan.day, label: scenario.label, plan })));
}

export function statefulJobResponse(job: Record<string, unknown>) {
  const result = job.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : {};
  const payload = job.payload && typeof job.payload === 'object' ? job.payload as Record<string, unknown> : {};
  const state = String(job.state ?? 'pending');
  const status = state === 'succeeded' ? 'completed' : state;
  const createdAt = new Date(String(job.createdAt));
  const updatedAt = new Date(String(job.updatedAt));
  const active = state === 'queued' || state === 'running';
  const elapsedEnd = active ? Date.now() : updatedAt.valueOf();
  return {
    ...job,
    status,
    scenarioId: payload.scenarioId ?? null,
    scenarioRevision: payload.scenarioRevision ?? null,
    elapsedSec: Number.isFinite(createdAt.valueOf()) && Number.isFinite(elapsedEnd)
      ? Math.max(0, (elapsedEnd - createdAt.valueOf()) / 1000) : 0,
    planId: result.planId ?? null,
    termination: result.termination ?? null,
  };
}
