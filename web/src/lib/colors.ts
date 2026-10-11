/*
 * Distinct route palette. the backend assigns a stable color per vehicle within a plan
 * (see data-api-mapping.md). The sample plan uses entries from this list so the
 * list, map, and timeline agree. Tuned for the warm ivory basemap: saturated
 * enough to read over pale landuse, distinct in hue order.
 */
export const ROUTE_COLORS: string[] = [
  '#2e7d5b', // deep green (primary family)
  '#2563eb', // blue
  '#d97706', // amber
  '#9333ea', // violet
  '#dc2626', // red
  '#0891b2', // cyan
  '#ca8a04', // gold
  '#be185d', // magenta
  '#15803d', // leaf green
  '#4338ca', // indigo
];

/** Deterministic color for a vehicle id, as a fallback when none is assigned. */
export function routeColor(index: number): string {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}
