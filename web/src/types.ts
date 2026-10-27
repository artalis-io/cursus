/*
 * TypeScript mirror of the backend -> frontend Plan contract.
 * Source of truth: docs/data-api-mapping.md and server/src/types.ts.
 * All times are seconds-from-midnight; distances are kilometers; coords [lon, lat].
 */

export type PlanSource = 'saved' | 'live' | 'sample';

export interface PlanProvenance {
  datasetSha256?: string;
  planningPolicy?: { id: string; date: string; exceptions: { orderNo: string; reason: string; maxTonnage?: number; requiresTailLift?: boolean }[] };
  inputSha256: string;
  solverConfig: Record<string, unknown>; // raw Surge config (seed, max_time_seconds, hard_*, ...)
  termination: string;                    // OK | LIMIT | ...
  validation: { valid: boolean; violations: ValidationViolation[] };
}

export interface ValidationViolation {
  type: string;            // HARD_TW | CAPACITY | TAIL_LIFT | VEHICLE_SIZE | ...
  soft?: boolean;          // equipment, GVW access, time windows and capacity are hard
  dimension?: string;
  vehicle_id?: number;
  request_id?: number;
  orderNo?: string;
  trip?: number;
  actual?: number;
  limit?: number;
}

export interface PlanStats {
  servedOrders: number;
  totalOrders: number;
  deliveryStops: number;
  trips: number;
  vehiclesUsed: number;
  totalDistanceKm: number;
  solveElapsedSeconds: number | null;
}

export interface Depot { name: string; lon: number; lat: number }

export type StopType = 'delivery' | 'pickup' | 'service' | 'depot';

export interface Stop {
  requestId?: number;
  orderId: string | null;
  orderNo: string;
  customer: string | null;
  city: string | null;
  lon: number;
  lat: number;
  seq: number;
  type: StopType;
  arrivalSec: number;
  serviceStartSec: number;
  departureSec: number;
  twStartSec: number;
  twEndSec: number;
  pallets: number;
  weightKg: number;
  serviceMin: number;
  waitSec: number;
  travelToSec: number;
  lateBySec: number;
  requiresTailLift: boolean;
  maxTonnage: number | null;
}

export interface Trip {
  manualTripId?: string;
  index: number;
  startSec: number;
  endSec: number;
  distanceKm: number;
  reloadSecAfter: number;
  loadKg: number;
  loadPallets: number;
  costFt: number | null;
  stops: Stop[];
  /** Road-following path from Velo, cached with the plan. [lon, lat] pairs. */
  geometry: GeoJSON.LineString | null;
}

export interface Vehicle {
  unavailable?: boolean;
  id: number;
  ref: string;
  vehicleClass: string | null;
  isSubcontractor: boolean;
  tonnage: number | null;
  hasTailLift: boolean;
  /** Assigned by the backend from a fixed distinct palette; stable within a plan. */
  color: string;
  capacityKg: number;
  capacityPallets: number;
  tripCount: number;
  finishTimeSec: number;
  peakKg: number;
  peakPallets: number;
  distanceKm: number;
  trips: Trip[];
}

export type UnassignedReason = 'PINNED_INFEASIBLE' | 'NEEDS_TAIL_LIFT' | 'OVER_CAPACITY' | 'OVERSIZE' | 'CONSTRAINED' | 'MANUAL_UNASSIGNED';
export interface UnassignedOrder {
  requestId?: number;
  orderId: string | null;
  orderNo: string;
  customer: string | null;
  city: string | null;
  lon: number | null;
  lat: number | null;
  reason: string | null;
  reasonCode: UnassignedReason | null;
}

export interface PlanVehicleCost {
  vehicleId: number;
  ref: string;
  vehicleClass: string | null;
  distanceKm: number;
  fixedCost: number;
  variableCost: number;
  totalCost: number;
}
export interface PlanCost {
  currency: string;
  source: 'demo' | 'external';
  total: number;
  fixed: number;
  variable: number;
  perVehicle: PlanVehicleCost[];
}

export type Objective = 'vehicles' | 'distance';

export interface Plan {
  manual?: { parentPlanId:string; layout:ManualLayout };
  assignments?: { parentPlanId:string; layout:ManualLayout };
  id: string;
  scenarioId: string;
  scenarioRevision: number;
  day: string;
  createdAt: string;
  source: PlanSource;
  objective: Objective;
  provenance: PlanProvenance;
  stats: PlanStats;
  cost: PlanCost | null;
  depot: Depot;
  vehicles: Vehicle[];
  unassigned: UnassignedOrder[];
}

export interface ManualLayout {
  datasetSha256:string;
  decisions:Record<string,{kind:'vehicle';vehicleId:number}|{kind:'unassigned'}>;
  origins:Record<string,string>;
  history:{operationId:string;requestId:number;actorId:string;at:string;action:string;from:{vehicleId:number}|null;to:{vehicleId:number}|null}[];
}
export type ManualCommand = {op:'assign';requestId:number;vehicleId:number;tripId:string;position:number}|{op:'deassign'|'release';requestId:number};
export interface ManualIntent {parentPlanId:string;batch:{operationId:string;datasetSha256:string;commands:ManualCommand[]};vehicle?:{id:number;excluded:boolean};undo?:true}
export interface ManualContext {enabled:boolean;reason?:'fresh_plan_required';requiresRevalidation?:boolean;datasetSha256?:string;fleet?:Vehicle[];canUndo?:boolean;actors?:Record<string,string>}
export interface ManualPreview {stats:PlanStats;cost:PlanCost|null;validation:PlanProvenance['validation']}

/* ---- API shapes ---- */
export interface DaySummary {
  id: string;
  isoDate: string;
  label: string;
  orders: number | null;
  vehicles: number | null;
  baseScenarioId: string;
  baselinePlanId: string;
}

export interface Pin { orderNo: string; vehicleId: number }
export interface Forbid { orderNo: string; vehicleId: number }
export interface VehicleOverride {
  vehicleId: number;
  capacityKg?: number;
  capacityPallets?: number;
  shiftEarlySec?: number;
  shiftLateSec?: number;
  maxTrips?: number;
  maxDistanceKm?: number;
  maxDurationMin?: number;
}
export type VehicleConstraintPatch = Omit<VehicleOverride, 'vehicleId'>;

export interface Scenario {
  manualPlanId?:string;
  id: string;
  day: string;
  kind: 'base' | 'copy';
  parentId: string | null;
  revision: number;
  label: string;
  removedVehicleIds: number[];
  pins: Pin[];
  forbids: Forbid[];
  vehicleOverrides: VehicleOverride[];
  sequences: VehicleSequence[];
  createdAt: string;
}

/* A manual stop order for one vehicle (orders kept on it, solved in order);
 * `locked` freezes the route exactly (no other order may be added). */
export interface VehicleSequence { vehicleId: number; orderNos: string[]; locked?: boolean }

/* A single dispatcher edit; mirrors the backend ScenarioEdit union. */
export type ScenarioEdit =
  | { op: 'removeVehicle'; vehicleId: number }
  | { op: 'restoreVehicle'; vehicleId: number }
  | { op: 'pin'; orderNo: string; vehicleId: number }
  | { op: 'unpin'; orderNo: string }
  | { op: 'forbid'; orderNo: string; vehicleId: number }
  | { op: 'unforbid'; orderNo: string; vehicleId: number }
  | { op: 'setVehicleConstraint'; vehicleId: number; patch: VehicleConstraintPatch }
  | { op: 'clearVehicleConstraint'; vehicleId: number }
  | { op: 'setSequence'; vehicleId: number; orderNos: string[]; locked?: boolean }
  | { op: 'clearSequence'; vehicleId: number }
  | { op: 'clearOverrides' };

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface Job {
  id: string;
  scenarioId: string;
  scenarioRevision: number;
  status: JobStatus;
  elapsedSec: number;
  planId: string | null;
  termination: string | null;
  error: string | null;
  kind?: 'solve' | 'import';
  stage?: string;
  result?: unknown;
}

export interface Comparison {
  base: { planId: string; stats: PlanStats; cost: PlanCost | null };
  revised: { planId: string; stats: PlanStats; cost: PlanCost | null };
  deltas: { servedOrders: number; vehiclesUsed: number; trips: number; totalDistanceKm: number; unassigned: number; costTotal: number | null };
  costComparison: 'comparable' | 'different_tariff' | 'unavailable';
  newlyUnassigned: { orderNo: string; customer: string | null; city: string | null; fromVehicleRef: string }[];
  nowServed: { orderNo: string; customer: string | null; city: string | null; toVehicleRef: string }[];
  movedOrders: { orderNo: string; customer: string | null; fromVehicleRef: string; toVehicleRef: string }[];
  removedVehicles: string[];
  addedVehicles: string[];
}

/** A flattened reference to a selected item, driving map/timeline/inspector. */
export type Selection =
  | { kind: 'vehicle'; vehicleId: number }
  | { kind: 'trip'; vehicleId: number; tripIndex: number }
  | { kind: 'stop'; vehicleId: number; tripIndex: number; seq: number }
  | { kind: 'unassigned'; orderNo: string;requestId?:number }
  | null;
