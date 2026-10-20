import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { cookieValue, type Principal } from './auth.js';
import { canWrite, isReadMethod, isRole } from './roles.js';

interface AccessOptions {
  authenticate: (token: string | undefined) => Principal | null | Promise<Principal | null>;
  tenantId: string;
  publicOrigin: string;
}

function viewToken(cookie: string | undefined): string {
  return createHash('sha256').update(cookieValue(cookie, 'cursus_session') || '').digest('hex');
}

export function viewIdentity<T extends { role: string }>(principal: T, cookie: string | undefined): T & { effectiveRole: string; viewingAs: string | null } {
  const viewingAs = principal.role === 'admin' && cookieValue(cookie, 'cursus_view_as') === viewToken(cookie) ? 'reviewer' : null;
  return { ...principal, effectiveRole: viewingAs || principal.role, viewingAs };
}

/** Installed before body parsers and handlers in BOTH runtimes. New API
 * mutations are denied to Reviewers by default, including compute-only POSTs.
 * Authentication exchanges and logout are deliberately not business writes. */
export function registerAccessControl(app: FastifyInstance, options?: AccessOptions): void {
  app.post<{ Body: { role?: unknown } }>('/api/auth/view-as', async (req, reply) => {
    if (!options) return reply.code(403).send({ error: 'authenticated Admin required' });
    const principal = await options.authenticate(cookieValue(req.headers.cookie, 'cursus_session'));
    if (!principal || principal.tenantId !== options.tenantId) return reply.code(401).send({ error: 'authentication required' });
    if (principal.role !== 'admin' || req.headers.origin !== options.publicOrigin) return reply.code(403).send({ error: 'Admin and same origin required' });
    if (req.body?.role !== 'reviewer' && req.body?.role !== null) return reply.code(400).send({ error: 'role must be reviewer or null' });
    const enabled = req.body.role === 'reviewer';
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Set-Cookie', `cursus_view_as=${enabled ? viewToken(req.headers.cookie) : ''}; Path=/; HttpOnly; SameSite=Strict${options.publicOrigin.startsWith('https:') ? '; Secure' : ''}${enabled ? '' : '; Max-Age=0'}`);
    return { viewingAs: enabled ? 'reviewer' : null };
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!options) return;
    let path: string;
    try { path = decodeURIComponent(req.url.split('?', 1)[0]!).replace(/\/+/g, '/'); }
    catch { return reply.code(400).send({ error: 'invalid request path' }); }
    const publicPaths = ['/api/health', '/api/auth/me', '/api/auth/magic-link', '/api/auth/verify',
      '/api/auth/logout', '/api/auth/view-as', '/api/auth/workspace', '/api/auth/workspace/icon'];
    if (publicPaths.includes(path) || !(path.startsWith('/api/') || path === '/tiles.vector.json' || path.startsWith('/tiles/'))) return;
    const principal = await options.authenticate(cookieValue(req.headers.cookie, 'cursus_session'));
    if (!principal || !isRole(principal.role) || principal.tenantId !== options.tenantId)
      return reply.code(401).send({ error: 'authentication required' });
    if (!isReadMethod(req.method)) {
      if (!canWrite(viewIdentity(principal, req.headers.cookie).effectiveRole as 'admin' | 'reviewer')) return reply.code(403).send({ error: 'Reviewer access is read-only' });
      if (req.headers.origin !== options.publicOrigin) return reply.code(403).send({ error: 'invalid request origin' });
    }
  });
}
