import { createContext, useContext } from 'react';

// UI convenience only. Server-side membership checks remain authoritative.
// Missing or unknown identity fails closed, never grants editing permission.
export const RoleContext = createContext<'admin' | 'reviewer' | null>(null);
export const useCanEdit = (): boolean => useContext(RoleContext) === 'admin';
