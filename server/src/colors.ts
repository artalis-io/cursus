/* Distinct, legible-on-ivory route colors, assigned stably by vehicle order so
 * the list, map and timeline always agree. Mirrored in the frontend theme. */
export const ROUTE_COLORS = [
  '#2e7d5b', // deep green
  '#b4572a', // terracotta
  '#3b6ea5', // steel blue
  '#8a5fb0', // muted violet
  '#c29a2e', // ochre
  '#4a8f8c', // teal
  '#a8484f', // brick
  '#5f7d3a', // olive
  '#7a6a9c', // slate violet
  '#2f6f8f', // marine
  '#9c6b3c', // bronze
  '#566b7a', // graphite blue
];

export function colorForIndex(i: number): string {
  return ROUTE_COLORS[i % ROUTE_COLORS.length]!;
}
