import type { FastifyInstance } from 'fastify';
import { cookieValue, type Principal } from './auth.js';
import { canWrite, isReadMethod, isRole } from './roles.js';

interface AccessOptions {
  authenticate: (token: string | undefined) => Principal | null | Promise<Principal | null>;
  tenantId: string;
  publicOrigin: string;
}

/** Installed before body parsers and handlers in BOTH runtimes. New API
 * mutations are denied to Reviewers by default, including compute-only POSTs.
 * Authentication exchanges and logout are deliberately not business writes. */
export function registerAccessControl(app: FastifyInstance, options?: AccessOptions): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!options) return;
    let path: string;
    try { path = decodeURIComponent(req.url.split('?', 1)[0]!).replace(/\/+/g, '/'); }
    catch { return reply.code(400).send({ error: 'invalid request path' }); }
    const publicPaths = ['/api/health', '/api/auth/me', '/api/auth/magic-link', '/api/auth/verify',
      '/api/auth/logout', '/api/auth/workspace', '/api/auth/workspace/icon'];
    if (publicPaths.includes(path) || !(path.startsWith('/api/') || path === '/tiles.vector.json' || path.startsWith('/tiles/'))) return;
    const principal = await options.authenticate(cookieValue(req.headers.cookie, 'cursus_session'));
    if (!principal || !isRole(principal.role) || principal.tenantId !== options.tenantId)
      return reply.code(401).send({ error: 'authentication required' });
    if (!isReadMethod(req.method)) {
      if (!canWrite(principal.role)) return reply.code(403).send({ error: 'Reviewer access is read-only' });
      if (req.headers.origin !== options.publicOrigin) return reply.code(403).send({ error: 'invalid request origin' });
    }
  });
}
