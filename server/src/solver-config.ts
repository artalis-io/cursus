import { config } from './config.js';

/** Cursus always uses HGS-style population search. Do not inherit a legacy
 * dataset's population=false, auto/all-core thread count, or single-generation
 * setting (one generation falls back to plain parallel search in Surge). */
export function populationConfig(previous: Record<string, unknown>): Record<string, unknown> {
  return { ...previous, population: true, population_threads: config.solvePopulationThreads, population_generations: 3 };
}
