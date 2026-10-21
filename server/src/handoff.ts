import type { Plan } from './types.js';
import type { Scenario } from './store.js';
import type { PlanningPolicy } from './plan/policy.js';

export type HandoffStatus = 'Draft' | 'Approved' | 'Superseded';
export interface HandoffActor { userId: string | null; email: string | null; identitySource: 'approval-event' | 'user-record' | 'local' | 'unavailable' }
/** Versioned export envelope, distinct from the existing route-file schema. */
export interface HandoffMetadata {
  version: 1;
  status: HandoffStatus;
  planId: string;
  scenarioId: string;
  scenarioRevision: number;
  currentScenarioRevision: number | null;
  planSha256: string;
  checkedAt: string;
  approval: { workflowVersion: number; approvedAt: string; approver: HandoffActor; exceptionsAcknowledged: boolean } | null;
  blockers: string[];
  constraints: {
    evidence: 'stored-solver-and-mapped-plan';
    validation: Plan['provenance']['validation'] | null;
    scenario: Pick<Scenario, 'removedVehicleIds' | 'pins' | 'forbids' | 'vehicleOverrides' | 'sequences'> | null;
    scenarioEvidence: 'matching-revision' | 'approval-event' | 'unavailable';
    vehicles: { id: number; ref: string; grossWeightTonnes: number | null; tailLift: boolean;
      capacityKg: number; capacityPallets: number;
      trips: { index: number; loadKg: number; loadPallets: number;
        stops: { orderNo: string; maxGrossWeightTonnes: number | null; requiresTailLift: boolean; windowStartSec: number; windowEndSec: number }[] }[] }[];
  };
  policy: PlanningPolicy | null;
}

export function constraintSnapshot(plan: Plan, scenario: Scenario | null, evidence: HandoffMetadata['constraints']['scenarioEvidence']): HandoffMetadata['constraints'] {
  return {
    evidence: 'stored-solver-and-mapped-plan', validation: plan.provenance?.validation ?? null,
    scenario: scenario ? structuredClone({ removedVehicleIds: scenario.removedVehicleIds, pins: scenario.pins,
      forbids: scenario.forbids, vehicleOverrides: scenario.vehicleOverrides, sequences: scenario.sequences }) : null,
    scenarioEvidence: evidence,
    vehicles: plan.vehicles.map(v => ({ id: v.id, ref: v.ref, grossWeightTonnes: v.tonnage, tailLift: v.hasTailLift,
      capacityKg: v.capacityKg, capacityPallets: v.capacityPallets,
      trips: v.trips.map(trip => ({ index: trip.index, loadKg: trip.loadKg, loadPallets: trip.loadPallets,
        stops: trip.stops.map(s => ({ orderNo: s.orderNo, maxGrossWeightTonnes: s.maxTonnage, requiresTailLift: s.requiresTailLift,
          windowStartSec: s.twStartSec, windowEndSec: s.twEndSec })) })) })),
  };
}

/** Legacy has no shared approval ledger. Never manufacture an approval. */
export function legacyHandoff(plan: Plan, scenario: Scenario | undefined, planSha256: string): HandoffMetadata {
  const fresh = scenario?.revision === plan.scenarioRevision;
  return { version: 1, status: fresh ? 'Draft' : 'Superseded', planId: plan.id, scenarioId: plan.scenarioId,
    scenarioRevision: plan.scenarioRevision, currentScenarioRevision: scenario?.revision ?? null, planSha256,
    checkedAt: new Date().toISOString(), approval: null,
    blockers: ['Shared approval is unavailable in the legacy runtime.', ...(!fresh ? ['Scenario revision changed or no longer exists.'] : [])],
    constraints: constraintSnapshot(plan, fresh ? scenario! : null, fresh ? 'matching-revision' : 'unavailable'),
    policy: plan.provenance?.planningPolicy ?? null };
}

export function exportFilename(planId: string, status: HandoffStatus, suffix: string): string {
  return `cursus-${planId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}-${status.toLowerCase()}.${suffix}`;
}
