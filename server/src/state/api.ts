import Fastify, { type FastifyInstance } from 'fastify';
import type { StatefulStore } from './postgres.js';
import { ScenarioRepository } from './scenarios.js';
import { validateScenarioEdit, type ScenarioEdit } from '../store.js';
import { cookieValue } from '../auth.js';
import type { StatefulAuthService } from './auth.js';

export interface StatefulApiOptions { store: StatefulStore; tenantId: string; tenantName: string; auth?: StatefulAuthService; publicOrigin?: string }

/** Stateful HTTP surface used by the runtime integration tests and, after
 * cutover, by the production entry point. Every repository is tenant-bound. */
export async function createStatefulApi(options: StatefulApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await options.store.ensureTenant(options.tenantId, options.tenantName);
  await options.auth?.initialize();
  const scenarios = new ScenarioRepository(options.store, options.tenantId);
  app.addHook('onRequest', async (req, reply) => {
    if (!options.auth || req.url.startsWith('/api/health') || req.url.startsWith('/api/auth/')) return;
    const principal = await options.auth.authenticate(cookieValue(req.headers.cookie, 'cursus_session'));
    if (!principal || principal.tenantId !== options.tenantId) return reply.code(401).send({ error: 'authentication required' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== options.publicOrigin)
      return reply.code(403).send({ error: 'invalid request origin' });
  });
  app.get('/api/health', async () => ({ status: 'ok', service: 'cursus-api', runtime: 'stateful' }));
  app.post<{ Body: { email?: string } }>('/api/auth/magic-link', async (req, reply) => {
    if (options.auth && typeof req.body?.email === 'string') await options.auth.requestMagicLink(req.body.email);
    return reply.code(202).send({ accepted: true });
  });
  app.get<{ Querystring: { token?: string } }>('/api/auth/verify', async (req, reply) => {
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
  app.post<{ Params: { id: string }; Body: { budgetSec?: number; objective?: string } }>('/api/scenarios/:id/solve', async (req, reply) => {
    const scenario = await scenarios.get(req.params.id); if (!scenario) return reply.code(404).send({ error: 'scenario not found' });
    const id = await options.store.enqueueJob(options.tenantId, 'solve', `solve/${scenario.id}/${scenario.revision}/${randomKey()}`, {
      scenarioId: scenario.id, scenarioRevision: scenario.revision, budgetSec: req.body?.budgetSec, objective: req.body?.objective ?? 'vehicles', scenario,
    });
    return reply.code(202).send({ id, status: 'pending', scenarioId: scenario.id, scenarioRevision: scenario.revision });
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => (await options.store.getJob(options.tenantId, req.params.id)) ?? reply.code(404).send({ error: 'job not found' }));
  app.get<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => (await options.store.getPlan(options.tenantId, req.params.id)) ?? reply.code(404).send({ error: 'plan not found' }));
  return app;
}

function randomKey(): string { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
