import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { cookieValue, type Principal } from './auth.js';
import { hasPermission, isReadMethod, isRole, permissions, rolePermissions, type Permission } from './roles.js';
import { managedPath, routePermission } from './route-permissions.js';

declare module 'fastify' {
  interface FastifyContextConfig { permission?: Permission | 'public' }
  interface FastifyRequest { cursusPrincipal?: Principal }
}

interface AccessOptions {
  authenticate: (token: string | undefined) => Principal | null | Promise<Principal | null>;
  tenantId: string;
  publicOrigin: string;
  audit?: (principal: Principal, detail: Record<string, unknown>) => void | Promise<void>;
}

function viewToken(cookie: string | undefined): string {
  return createHash('sha256').update(cookieValue(cookie, 'cursus_session') || '').digest('hex');
}

export function viewIdentity<T extends { role: string }>(principal: T, cookie: string | undefined) {
  const mode = cookieValue(cookie, 'cursus_view_as');
  const token = viewToken(cookie);
  const viewingAs = principal.role !== 'admin' ? null
    : mode === token || mode === `reviewer.${token}` ? 'reviewer'
    : mode === `planner.${token}` ? 'planner' : null;
  const effectiveRole = viewingAs || principal.role;
  return { ...principal, effectiveRole, viewingAs, permissions: isRole(effectiveRole) ? rolePermissions[effectiveRole] : [] };
}

/** Installed before body parsers and handlers in BOTH runtimes. New API
 * mutations are denied to Reviewers by default, including compute-only POSTs.
 * Authentication exchanges and logout are deliberately not business writes. */
export function registerAccessControl(app: FastifyInstance, options?: AccessOptions): void {
  app.addHook('onRoute', route => {
    if (!managedPath(route.url)) return;
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      const permission = routePermission(method, route.url) ?? route.config?.permission;
      if (!permission || (permission !== 'public' && !permissions.includes(permission)))
        throw new Error(`Unclassified business route: ${method} ${route.url}`);
    }
  });
  app.post<{ Body: { role?: unknown } }>('/api/auth/view-as', async (req, reply) => {
    if (!options) return reply.code(403).send({ error: 'authenticated Admin required' });
    const principal = await options.authenticate(cookieValue(req.headers.cookie, 'cursus_session'));
    if (!principal || principal.tenantId !== options.tenantId) return reply.code(401).send({ error: 'authentication required' });
    if (principal.role !== 'admin' || req.headers.origin !== options.publicOrigin) return reply.code(403).send({ error: 'Admin and same origin required' });
    if (req.body?.role !== 'reviewer' && req.body?.role !== 'planner' && req.body?.role !== null) return reply.code(400).send({ error: 'role must be planner, reviewer or null' });
    const enabled = req.body.role !== null;
    await options.audit?.(principal, { permission: 'role.preview', role: principal.role, effectiveRole: req.body.role ?? 'admin', route: '/api/auth/view-as' });
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Set-Cookie', `cursus_view_as=${enabled ? `${req.body.role}.${viewToken(req.headers.cookie)}` : ''}; Path=/; HttpOnly; SameSite=Strict${options.publicOrigin.startsWith('https:') ? '; Secure' : ''}${enabled ? '' : '; Max-Age=0'}`);
    return { viewingAs: req.body.role };
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!options) return;
    let path: string;
    try { path = decodeURIComponent(req.url.split('?', 1)[0]!).replace(/\/+/g, '/'); }
    catch { return reply.code(400).send({ error: 'invalid request path' }); }
    if (!managedPath(path)) return;
    const permission = routePermission(req.method, req.routeOptions.url ?? '') ?? req.routeOptions.config.permission;
    if (permission === 'public') return;
    const principal = await options.authenticate(cookieValue(req.headers.cookie, 'cursus_session'));
    if (!principal || !isRole(principal.role) || principal.tenantId !== options.tenantId)
      return reply.code(401).send({ error: 'authentication required' });
    const identity = viewIdentity(principal, req.headers.cookie);
    req.cursusPrincipal = principal;
    if (!permission || !hasPermission(identity.effectiveRole, permission))
      return reply.code(403).send({ error: 'permission denied', permission: permission ?? 'unclassified' });
    if (!isReadMethod(req.method)) {
      if (req.headers.origin !== options.publicOrigin) return reply.code(403).send({ error: 'invalid request origin' });
      // Durable authorization intent BEFORE handlers. Not a claim that the
      // mutation completed; repository transactions remain authoritative.
      await options.audit?.(principal, { role: principal.role, effectiveRole: identity.effectiveRole,
        permission, method: req.method, route: req.routeOptions.url,
        target: req.params });
    }
  });
}
