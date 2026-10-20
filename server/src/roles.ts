export type Role = 'admin' | 'reviewer';
export const isRole = (value: unknown): value is Role => value === 'admin' || value === 'reviewer';
export const canWrite = (role: unknown): boolean => role === 'admin';
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
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['admins', 'reviewers'].includes(k)))
      throw new Error('invalid authentication role configuration');
    for (const [key, role] of [['admins', 'admin'], ['reviewers', 'reviewer']] as const) {
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
