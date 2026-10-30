import type { FastifyInstance } from 'fastify';

/** Client intent, not a revision silently reread by the server. */
export function expectedRevision(headers: Record<string, unknown>): number | null {
  const value = headers['if-match'];
  if (typeof value !== 'string' || !/^"(?:0|[1-9][0-9]*)"$/.test(value)) return null;
  const revision = Number(value.slice(1, -1));
  return Number.isSafeInteger(revision) ? revision : null;
}

export function registerScenarioPreconditions(app: FastifyInstance,
  get: (id: string) => { revision: number;supersededBy?:unknown } | null | Promise<{ revision: number;supersededBy?:unknown } | null>): void {
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url;
    const guarded = req.method === 'DELETE' && route === '/api/scenarios/:id'
      || req.method === 'POST' && /^\/api\/scenarios\/:id\/(edit|edits|rename|solve|select-plan|profiles)$/.test(route ?? '');
    if (!guarded) return;
    if (req.headers['if-match'] === undefined)
      return reply.code(428).send({ error: 'Reload the scenario before making changes: If-Match revision required.' });
    const revision = expectedRevision(req.headers);
    if (revision === null) return reply.code(400).send({ error: 'If-Match must contain a quoted non-negative integer revision.' });
    const current = await get((req.params as { id: string }).id);
    if (!current) return reply.code(404).send({ error: 'scenario not found' });
    if(current.supersededBy)return reply.code(409).send({error:'This input snapshot is superseded. Open its replacement before making changes.'});
    if (current.revision !== revision)
      return reply.code(409).send({ error: 'This scenario changed in another workspace. Reload before continuing.', currentRevision: current.revision });
  });
}
