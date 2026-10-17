import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

/** Public deployment branding only, never identity, membership or tenant selection. */
export function workspaceBranding(tenantName: string) {
  return tenantName.trim().toLowerCase() === 'gyermelyi'
    ? { name: 'Gyermelyi', icon: '/api/auth/workspace/icon' } : null;
}

let icon: Buffer | undefined;
export function gyermelyiIcon(): Buffer {
  return icon ??= readFileSync(new URL('../assets/gyermelyi.png', import.meta.url));
}

export function registerWorkspaceBranding(app: FastifyInstance, tenantName: string): void {
  const branding = workspaceBranding(tenantName);
  if (branding) gyermelyiIcon(); // Missing packaged artwork must fail before serving.
  app.get('/api/auth/workspace', async (_req, reply) =>
    reply.header('Cache-Control', 'no-store').send({ branding }));
  app.get('/api/auth/workspace/icon', async (_req, reply) => branding
    ? reply.header('Cache-Control', 'public, max-age=86400').type('image/png').send(gyermelyiIcon())
    : reply.code(404).send({ error: 'not found' }));
}
