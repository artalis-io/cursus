import type { LoadedDay } from '../data/dataset.js';

/** Server-owned approval. No public scenario-edit operation can create one. */
export interface PlanningPolicy {
  version: 1;
  id: string;
  date: string;
  datasetRequestSha256: string;
  approvedAt: string;
  approvedBy: string;
  exceptions: { orderNo: string; reason: string; originalMaxTonnage?: number; maxTonnage?: number;
    originalRequiresTailLift?: boolean; requiresTailLift?: boolean }[];
}

/** Never mutate cached enrichment, and fail closed when approval/source drifts. */
export function withPlanningPolicy(day: LoadedDay, policy?: PlanningPolicy): LoadedDay {
  if (!policy) return day;
  if (policy.version !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(policy.id) ||
      policy.date !== day.def.isoDate || !/^[a-f0-9]{64}$/.test(policy.datasetRequestSha256) ||
      policy.datasetRequestSha256 !== day.datasetRequestSha256 ||
      !policy.approvedBy || !Number.isFinite(Date.parse(policy.approvedAt)) ||
      !Array.isArray(policy.exceptions) || policy.exceptions.length > 100)
    throw new Error('planning policy does not match the approved dataset/day');
  const enrichment = new Map(day.enrichment);
  const refs = new Set(day.request.tasks.filter(t => day.scopeTaskIds.has(t.id)).map(t => t.ref));
  const seen = new Set<string>();
  for (const exception of policy.exceptions) {
    const original = day.enrichment.get(exception.orderNo);
    if (!original || !refs.has(exception.orderNo) || seen.has(exception.orderNo) ||
        typeof exception.reason !== 'string' || !exception.reason.trim() || exception.reason.length > 500 ||
        (exception.maxTonnage === undefined && exception.requiresTailLift === undefined))
      throw new Error('invalid or out-of-scope planning exception');
    seen.add(exception.orderNo);
    const effective = { ...original };
    if (exception.maxTonnage !== undefined) {
      if (original.maxTonnage !== exception.originalMaxTonnage || !Number.isFinite(exception.maxTonnage) ||
          exception.maxTonnage <= 0 || exception.maxTonnage > 100)
        throw new Error('approved gross-weight exception no longer matches its source');
      effective.maxTonnage = exception.maxTonnage;
    }
    if (exception.requiresTailLift !== undefined) {
      if (typeof exception.requiresTailLift !== 'boolean' || original.requiresTailLift !== exception.originalRequiresTailLift)
        throw new Error('approved equipment exception no longer matches its source');
      effective.requiresTailLift = exception.requiresTailLift;
    }
    enrichment.set(exception.orderNo, effective);
  }
  return { ...day, enrichment, planningPolicy: structuredClone(policy) };
}
