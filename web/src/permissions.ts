import { createContext, useContext } from 'react';
import { hasPermission, type Role, type Permission } from '../../server/src/roles';

// UI convenience only. Server-side membership checks remain authoritative.
// Missing or unknown identity fails closed, never grants editing permission.
export const RoleContext = createContext<Role | null>(null);
export const PermissionsContext = createContext<readonly Permission[] | null>(null);
export const StaleWorkspaceContext = createContext(false);
export function usePermission(permission: Permission): boolean {
  const role = useContext(RoleContext);
  const granted = useContext(PermissionsContext);
  const stale = useContext(StaleWorkspaceContext);
  if (stale && ['scenario.edit', 'plan.evaluate', 'optimization.submit', 'plan.review', 'plan.approve'].includes(permission)) return false;
  return hasPermission(role, permission) && (granted === null || granted.includes(permission));
}
