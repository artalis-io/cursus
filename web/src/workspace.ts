import { createContext } from 'react';

// Display-only identity from /api/auth/me, never an authorization selector.
export const WorkspaceNameContext = createContext<string | null>(null);
export const WorkspaceActorContext = createContext<string | null>(null);
export const WorkspaceTenantContext = createContext<string | null>(null);
export const WorkspaceFeaturesContext = createContext<{planningProfiles?:boolean;acknowledgedHandoff?:boolean;inputUpdates?:boolean}>({});

export const SolveLimitsContext = createContext<{maxSeconds:number}>({maxSeconds:600});
