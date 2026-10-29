/* ---- Surge request/solution shapes (subset we read) ---- */

export interface SurgeLocation { x: number; y: number } // x=lon, y=lat

export interface SurgeTask {
  id: number;
  type: string;
  location_id: number;
  tw_early: number; // sec from midnight
  tw_late: number;
  service_seconds: number;
  demand: number[]; // [weight_kg, pallets]
  ref: string; // order_no
}

export interface SurgeRequestVehicle {
  approved_capacity?:number[]; // application-only upper bounds from an approved profile
  trip_reload_seconds?:number;
  id: number;
  ref: string; // e.g. "RIC-124"
  gross_weight_kg?: number; // application metadata: GVW, never payload capacity
  has_tail_lift?: boolean; // explicit capability; false overrides legacy enrichment
  capacity: number[]; // [kg, pallets]
  start_depot_id: number;
  end_depot_id: number;
  fixed_cost?: number;
  shift_early?: number;   // sec from midnight
  shift_late?: number;
  max_trips?: number;
  max_distance?: number;  // meters
  max_duration?: number;  // seconds
}

export interface SurgeRequestDef {
  id: number;
  delivery_task_id: number;
  unassigned_penalty?: number;
  allowed_vehicles?: number[];   // restrict this order to these vehicles (pin)
  forbidden_vehicles?: number[]; // exclude these vehicles for this order
}

export interface SurgeTravel {
  location_count: number;
  distances: number[]; // meters, row-major i*N+j
  durations: number[]; // seconds
}

export interface SurgeRequest {
  config: Record<string, unknown>;
  dimension_count: number;
  demand_sign_convention: number;
  locations: SurgeLocation[];
  depots: unknown[];
  vehicles: SurgeRequestVehicle[];
  tasks: SurgeTask[];
  requests: SurgeRequestDef[];
  travel: SurgeTravel;
  precedences?: SurgePrecedence[];   // before_request completes before after_request
}

export interface SurgePrecedence { before: number; after: number }

export interface SurgeSolutionStop {
  request_id: number;
  task_id: number;
  type: string;
  trip_index: number;
  arrival: number;
  service_start: number;
  departure: number;
}

export interface SurgeSolutionRoute {
  vehicle_id: number;
  distance: number; // meters
  duration: number; // seconds
  trip_count: number;
  stops: SurgeSolutionStop[];
}

export interface SurgeSolution {
  status: string; // OK | LIMIT | INFEASIBLE | ERROR | ...
  stats: {
    iterations?: number;
    total_cost?: number;
    total_distance?: number; // meters
    unassigned?: number;
    vehicles_used?: number;
    trips?: number;
    elapsed_seconds?: number;
  };
  routes: SurgeSolutionRoute[];
  unassigned: number[]; // request_ids
}

/* ---- backend <-> frontend Plan contract (see docs/data-api-mapping.md) ---- */

export interface PlanStop {
  requestId?: number; // stable dataset-scoped solver identity; never infer ambiguous labels
  orderId: string | null;
  orderNo: string;
  customer: string | null;
  city: string | null;
  lon: number;
  lat: number;
  seq: number;
  type: string;
  arrivalSec: number;
  serviceStartSec: number;
  departureSec: number;
  twStartSec: number;
  twEndSec: number;
  pallets: number;
  weightKg: number;
  serviceMin: number;
  waitSec: number;      // service_start - arrival
  travelToSec: number;  // travel from previous stop/depot
  lateBySec: number;    // max(0, arrival - tw_late)
  requiresTailLift: boolean;
  maxTonnage: number | null; // max vehicle GVW (t) that can access
}

export interface PlanTrip {
  manualTripId?: string;
  index: number;
  startSec: number;       // depot departure for this trip
  endSec: number;         // depot return for this trip
  distanceKm: number;
  reloadSecAfter: number; // reload dwell before next trip (0 if last)
  loadKg: number;         // summed delivery load for the trip
  loadPallets: number;
  costFt: number | null;  // estimated cost of this trip under the tariff
  stops: PlanStop[];
  geometry: GeoJSONLineString | null; // road-following; null until computed
}

export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: [number, number][]; // [lon, lat]
}

export interface PlanVehicle {
  id: number;
  ref: string;
  vehicleClass: string | null;
  isSubcontractor: boolean;
  tonnage: number | null;
  hasTailLift: boolean;
  color: string;
  capacityKg: number;
  capacityPallets: number;
  tripCount: number;
  finishTimeSec: number;
  peakKg: number;
  peakPallets: number;
  distanceKm: number;
  trips: PlanTrip[];
}

/* A best-effort inferred reason an order went unassigned (Surge emits none).
 * PINNED_INFEASIBLE: locked to a vehicle (pin/sequence) that couldn't schedule it;
 * NEEDS_TAIL_LIFT / OVER_CAPACITY / OVERSIZE: no vehicle in the fleet can serve it;
 * CONSTRAINED: fit failed within time windows/routing across the available fleet. */
export type UnassignedReason = 'PINNED_INFEASIBLE' | 'NEEDS_TAIL_LIFT' | 'OVER_CAPACITY' | 'OVERSIZE' | 'CONSTRAINED' | 'MANUAL_UNASSIGNED';

export interface PlanUnassigned {
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

export interface PlanProvenance {
  shipmentSha256?:string;
  planningProfiles?: import('./planning-profiles.js').ProfileRef[];
  warmStart?:{planId:string;used:boolean};
  tariffSha256?:string;
  datasetSha256?: string;
  planningPolicy?: import('./plan/policy.js').PlanningPolicy;
  inputSha256: string;
  solverConfig: Record<string, unknown>;
  termination: string; // Surge status
  validation: { valid: boolean; violations: unknown[] };
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

/* Estimated operating cost of a plan under a carrier tariff. `source` is 'demo'
 * for the illustrative in-repo tariff or 'external' when a real rate card is
 * loaded from the (uncommitted) dataset dir. */
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
  currency: string;          // ISO code, e.g. 'HUF'
  source: 'demo' | 'external';
  total: number;
  fixed: number;
  variable: number;
  perVehicle: PlanVehicleCost[];
}

export interface Plan {
  shipmentMetadata?:import('./shipment-contract.js').ShipmentSnapshot;
  assignments?: { version: 1; parentPlanId: string; layout: import('./plan/manual.js').ManualLayout };
  manual?: { version: 1; parentPlanId: string; layout: import('./plan/manual.js').ManualLayout;
    parentScenario?:import('./store.js').Scenario;
    evaluation: import('./plan/manual-evaluate.js').ManualEvaluation };
  id: string;
  scenarioId: string;
  scenarioRevision: number;
  day: string;
  createdAt: string;
  source: 'saved' | 'live';
  objective: 'vehicles' | 'distance'; // solve objective used (fewest vehicles | least distance)
  provenance: PlanProvenance;
  stats: PlanStats;
  cost: PlanCost | null;              // null when no tariff is available
  depot: { name: string; lon: number; lat: number };
  vehicles: PlanVehicle[];
  unassigned: PlanUnassigned[];
}
