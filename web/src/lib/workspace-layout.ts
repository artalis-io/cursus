export interface WorkspaceLayout { fleet: number; inspector: number; timeline: number }
export const LAYOUT_KEY = 'cursus.workspace-layout.v1';
export const DEFAULT_LAYOUT: WorkspaceLayout = { fleet: 310, inspector: 340, timeline: 192 };
export const LIMITS = { fleet: [240, 520], inspector: [260, 560], timeline: [120, 360] } as const;
export const HANDLE_SIZE = 6;
export const MAP_MIN_WIDTH = 320;
export const MAP_MIN_HEIGHT = 120;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Only finite known dimensions are admitted; never trust browser storage. */
export function parseLayout(raw: string | null): WorkspaceLayout {
  try {
    const data: unknown = JSON.parse(raw ?? 'null');
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1) return { ...DEFAULT_LAYOUT };
    const result = { ...DEFAULT_LAYOUT };
    for (const key of Object.keys(result) as (keyof WorkspaceLayout)[]) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = Math.round(clamp(value, LIMITS[key][0], LIMITS[key][1]));
    }
    return result;
  } catch { return { ...DEFAULT_LAYOUT }; }
}

/** Fit the actual workspace without overwriting the user's desktop preference
 * when the viewport shrinks, a sidebar closes, or readiness expands. */
export function fitLayout(preferred: WorkspaceLayout, width: number, height: number, fleetOpen: boolean, inspectorOpen: boolean) {
  const desktop = width >= 1024;
  if (!desktop) return { ...DEFAULT_LAYOUT, desktop, fleetMax: 520, inspectorMax: 560, timelineMin: 120, timelineMax: 360 };
  const budget = width - MAP_MIN_WIDTH - HANDLE_SIZE * (Number(fleetOpen) + Number(inspectorOpen));
  const minFleet = fleetOpen ? LIMITS.fleet[0] : 0;
  const minInspector = inspectorOpen ? LIMITS.inspector[0] : 0;
  const extraFleet = fleetOpen ? clamp(preferred.fleet, ...LIMITS.fleet) - minFleet : 0;
  const extraInspector = inspectorOpen ? clamp(preferred.inspector, ...LIMITS.inspector) - minInspector : 0;
  const scale = Math.min(1, Math.max(0, budget - minFleet - minInspector) / (extraFleet + extraInspector || 1));
  const fleet = minFleet + Math.floor(extraFleet * scale);
  const inspector = minInspector + Math.floor(extraInspector * scale);
  const timelineMax = Math.max(0, Math.floor(Math.min(LIMITS.timeline[1], height - MAP_MIN_HEIGHT - HANDLE_SIZE)));
  const timelineMin = Math.min(LIMITS.timeline[0], timelineMax);
  return { desktop, fleet, inspector, timeline: clamp(preferred.timeline, timelineMin, timelineMax),
    fleetMax: Math.floor(Math.min(LIMITS.fleet[1], budget - inspector)),
    inspectorMax: Math.floor(Math.min(LIMITS.inspector[1], budget - fleet)), timelineMin, timelineMax };
}
