/** Browser preference only. Every restore must still read tenant-authorized APIs. */
export interface WorkspaceBookmark { version: 1; planId: string; day: string }
export function workspaceBookmarkKey(tenant: string | null, actor: string | null): string | null {
  return tenant && actor ? `cursus.workspace.v1:${encodeURIComponent(tenant)}:${encodeURIComponent(actor)}` : null;
}
export function parseWorkspaceBookmark(raw: string | null): WorkspaceBookmark | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const value = JSON.parse(raw);
    const id = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 1024 && ![...s].some(c => c.charCodeAt(0) < 32);
    return value?.version === 1 && id(value.planId) && id(value.day)
      ? { version: 1, planId: value.planId, day: value.day } : null;
  } catch { return null; }
}
