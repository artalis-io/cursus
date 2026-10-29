export type Role = 'admin' | 'planner' | 'reviewer';
export const isRole = (value: unknown): value is Role => value === 'admin' || value === 'planner' || value === 'reviewer';
export const permissions = ['workspace.read', 'workspace.export', 'scenario.create', 'scenario.rename',
  'scenario.edit', 'scenario.import', 'scenario.delete', 'plan.evaluate', 'plan.review', 'plan.approve', 'optimization.submit',
  'optimization.cancel', 'analysis.generate', 'dataset.upload', 'dataset.convert', 'dataset.validate',
  'dataset.admit', 'dataset.delete', 'role.preview', 'profile.propose', 'profile.approve'] as const;
export type Permission = typeof permissions[number];
const read: readonly Permission[] = ['workspace.read', 'workspace.export'];
const planning: readonly Permission[] = [...read, 'scenario.create', 'scenario.rename', 'scenario.edit',
  'scenario.import', 'plan.evaluate', 'plan.review', 'optimization.submit', 'optimization.cancel', 'analysis.generate','profile.propose'];
export const rolePermissions: Readonly<Record<Role, readonly Permission[]>> = {
  admin: permissions, planner: planning, reviewer: read,
};
export const hasPermission = (role: unknown, permission: Permission): boolean => isRole(role) && rolePermissions[role].includes(permission);
export const isReadMethod = (method: string): boolean => ['GET', 'HEAD', 'OPTIONS'].includes(method);

/** Private operator configuration. Plain legacy allowlists retain their admin
 * bootstrap behavior; JSON assigns explicit roles to NEW memberships only.
 * Existing database memberships remain authoritative, including demotions. */
export function parseRoleAllowlist(source: string): Map<string, Role> {
  const allowed = new Map<string, Role>();
  const add = (email: unknown, role: Role) => {
    if (typeof email !== 'string' || !/^[^\s,@]+@[^\s,@]+$/.test(email.trim())) throw new Error('invalid authentication allowlist entry');
    const normalized = email.trim().toLowerCase();
    if (allowed.has(normalized)) throw new Error('duplicate authentication allowlist entry');
    allowed.set(normalized, role);
  };
  if (source.trim().startsWith('{')) {
    let data: unknown;
    try { data = JSON.parse(source); }
    catch { throw new Error('invalid authentication role configuration'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['admins', 'planners', 'reviewers'].includes(k)))
      throw new Error('invalid authentication role configuration');
    for (const [key, role] of [['admins', 'admin'], ['planners', 'planner'], ['reviewers', 'reviewer']] as const) {
      const values = (data as Record<string, unknown>)[key] ?? [];
      if (!Array.isArray(values)) throw new Error('authentication role lists must be arrays');
      for (const email of values) add(email, role);
    }
  } else {
    for (const email of source.split(/[\s,]+/).filter(Boolean)) {
      // Repeated entries in historical plain allowlists were harmless.
      if (!allowed.has(email.toLowerCase())) add(email, 'admin');
    }
  }
  if (!allowed.size) throw new Error('authentication allowlist is empty');
  return allowed;
}
