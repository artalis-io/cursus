import type { Plan } from '../types.js';
import { withHardAccessValidation } from './access.js';

/** Repair derived counts on plans written before task identities were counted.
 * Every request is either represented by a delivery stop or by one unassigned
 * entry; display order numbers are allowed to repeat. */
export function withNormalizedPlanStats(plan: Plan): Plan {
  plan = withHardAccessValidation(plan);
  const servedOrders = Math.max(0, plan.stats.totalOrders - plan.unassigned.length);
  if (plan.stats.servedOrders === servedOrders) return plan;
  return { ...plan, stats: { ...plan.stats, servedOrders } };
}
