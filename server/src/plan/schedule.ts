import type { SurgeTravel } from '../types.js';

/* Shared per-trip schedule primitives. The mapper (reading Surge's solved
 * times) and the evaluate preview (forward-simulating them) must derive the
 * SAME downstream numbers — leg travel/distance, idle wait, lateness — or the
 * reorder preview can silently disagree with the Replan result. The
 * arrival/service/departure SOURCE differs by design; these formulas do not. */

export interface Leg {
  durSec(a: number, b: number): number; // travel seconds from location a to b
  distM(a: number, b: number): number;   // travel metres from location a to b
}

/** Row-major travel-matrix accessors (missing cells read as 0). */
export function makeLeg(travel: SurgeTravel): Leg {
  const N = travel.location_count, dur = travel.durations, dist = travel.distances;
  return {
    durSec: (a, b) => dur[a * N + b] ?? 0,
    distM: (a, b) => dist[a * N + b] ?? 0,
  };
}

/** Idle time spent waiting for a stop's window to open. */
export const waitSec = (arrival: number, serviceStart: number): number => Math.max(0, serviceStart - arrival);

/** Seconds past a stop's late bound (0 if on time). */
export const lateSec = (arrival: number, twLate: number): number => Math.max(0, arrival - twLate);
