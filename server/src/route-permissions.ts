import type { Permission } from './roles.js';

// Exact route templates, not prefix matching. Unknown routes cannot inherit
// permissions simply because their HTTP method looks read-only.
const policy: Record<string, Permission | 'public'> = {};
function routes(permission: Permission | 'public', method: string, paths: string[]) {
  for (const path of paths) policy[`${method} ${path}`] = permission;
}
routes('public', 'GET', ['/api/health', '/api/auth/me', '/api/auth/verify', '/api/auth/workspace', '/api/auth/workspace/icon']);
routes('public', 'POST', ['/api/auth/magic-link', '/api/auth/verify', '/api/auth/logout', '/api/auth/view-as']);
routes('workspace.read', 'GET', ['/api/config', '/api/days', '/api/scenarios', '/api/scenarios/:id',
  '/api/scenarios/:id/plans', '/api/jobs/:id', '/api/plans', '/api/plans/:id', '/api/compare', '/api/week',
  '/api/sage/status', '/api/import/summary', '/api/import/raw', '/api/import/canonical', '/api/import/catalog',
  '/api/import/datasets', '/tiles.vector.json', '/tiles/*']);
routes('workspace.read', 'GET', ['/api/plans/:id/workflow']);
routes('plan.review', 'POST', ['/api/plans/:id/review']);
routes('plan.approve', 'POST', ['/api/plans/:id/approve']);
routes('workspace.export', 'GET', ['/api/scenarios/:id/export', '/api/plans/:id/export.csv',
  '/api/plans/:id/routes.csv', '/api/plans/:id/routesheet.html', '/api/plans/:id/handoff.json']);
routes('scenario.create', 'POST', ['/api/scenarios']);
routes('scenario.rename', 'POST', ['/api/scenarios/:id/rename']);
routes('scenario.edit', 'POST', ['/api/scenarios/:id/edit', '/api/scenarios/:id/edits']);
routes('scenario.edit', 'POST', ['/api/scenarios/:id/manual-plan']);
routes('scenario.edit', 'POST', ['/api/scenarios/:id/select-plan']);
routes('plan.evaluate', 'POST', ['/api/scenarios/:id/manual-preview']);
routes('plan.evaluate', 'POST', ['/api/scenarios/:id/placements']);
routes('workspace.read', 'GET', ['/api/plans/:id/manual-context']);
routes('scenario.import', 'POST', ['/api/scenarios/import']);
routes('scenario.delete', 'DELETE', ['/api/scenarios/:id']);
routes('plan.evaluate', 'POST', ['/api/plans/:id/evaluate']);
routes('optimization.submit', 'POST', ['/api/scenarios/:id/solve']);
routes('optimization.cancel', 'DELETE', ['/api/jobs/:id']);
routes('analysis.generate', 'POST', ['/api/plans/:id/narrate', '/api/compare/narrate']);
routes('dataset.upload', 'POST', ['/api/import/upload', '/api/import/preview']);
routes('dataset.convert', 'POST', ['/api/import/geocode', '/api/import/datasets/:id/convert']);
routes('dataset.validate', 'POST', ['/api/import/datasets/:id/validate']);
routes('dataset.admit', 'POST', ['/api/import/admit', '/api/import/datasets/:id/admit']);
routes('dataset.delete', 'DELETE', ['/api/import/datasets/:id']);

export const routePermission = (method: string, path: string): Permission | 'public' | undefined =>
  policy[`${method === 'HEAD' ? 'GET' : method} ${path}`];
export const managedPath = (path: string): boolean => path.startsWith('/api/') || path === '/tiles.vector.json' || path.startsWith('/tiles/');
