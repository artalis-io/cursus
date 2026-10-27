/** Pure manual-layout commands. NOT a feasibility certificate or publication API.
 * The authoritative evaluator and transactional publisher must run afterwards. */
export interface ManualRoute {
  vehicleId: number;
  tripId: string;
  requestIds: number[];
}
export type ManualDecision = { kind: 'vehicle'; vehicleId: number } | { kind: 'unassigned' };
export type AssignmentOrigin = 'optimizer' | 'import' | 'manual' | 'historical';
export interface AssignmentEvent {
  operationId: string;
  index: number;
  requestId: number;
  action: ManualCommand['op'] | 'undo';
  actorId: string;
  at: string;
  from: AssignmentLocation | null;
  to: AssignmentLocation | null;
}
export interface AssignmentLocation { vehicleId: number; tripId: string; position: number }
export type ManualCommand =
  | { op: 'assign'; requestId: number; vehicleId: number; tripId: string; position: number }
  | { op: 'deassign'; requestId: number }
  | { op: 'release'; requestId: number };
export interface ManualLayout {
  datasetSha256: string;
  requestIds: number[];
  vehicleIds: number[];
  excludedVehicleIds: number[];
  lockedVehicleIds: number[];
  routes: ManualRoute[];
  unassigned: number[];
  decisions: Record<string, ManualDecision>;
  origins: Record<string, AssignmentOrigin>;
  history: AssignmentEvent[];
}
export interface ManualBatch {
  operationId: string;
  datasetSha256: string;
  commands: ManualCommand[];
}
export interface ManualActor { actorId: string; at: string }

export class ManualCommandError extends Error {}
function requireThat(test: unknown, message: string): asserts test {
  if (!test) throw new ManualCommandError(message);
}
const validId = (id: number): boolean => Number.isSafeInteger(id) && id >= 0;
const validTrip = (id: string): boolean => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);

/** Reject ambiguous, missing, duplicated or cross-scope identities before editing. */
export function assertManualLayout(layout: ManualLayout): void {
  requireThat(/^[a-f0-9]{64}$/.test(layout.datasetSha256), 'dataset checksum required');
  const requests = new Set(layout.requestIds), vehicles = new Set(layout.vehicleIds);
  requireThat(requests.size === layout.requestIds.length && layout.requestIds.every(validId), 'invalid request inventory');
  requireThat(vehicles.size === layout.vehicleIds.length && layout.vehicleIds.every(validId), 'invalid vehicle inventory');
  requireThat([...layout.excludedVehicleIds, ...layout.lockedVehicleIds].every(id => vehicles.has(id)), 'unknown vehicle restriction');
  const seen = new Set<number>();
  const trips = new Set<string>();
  for (const route of layout.routes) {
    requireThat(vehicles.has(route.vehicleId) && validTrip(route.tripId), 'unknown vehicle or invalid trip');
    const key = `${route.vehicleId}:${route.tripId}`;
    requireThat(!trips.has(key), 'duplicate trip'); trips.add(key);
    for (const id of route.requestIds) {
      requireThat(requests.has(id) && !seen.has(id), 'unknown or duplicate assignment'); seen.add(id);
    }
  }
  for (const id of layout.unassigned) {
    requireThat(requests.has(id) && !seen.has(id), 'unknown or duplicate unassigned request'); seen.add(id);
  }
  requireThat(seen.size === requests.size, 'request coverage is incomplete');
  for (const [id, decision] of Object.entries(layout.decisions)) {
    requireThat(requests.has(Number(id)) && String(Number(id)) === id, 'unknown decision identity');
    requireThat(decision.kind === 'unassigned' || decision.kind === 'vehicle' && vehicles.has(decision.vehicleId), 'invalid retained decision');
  }
}

function location(layout: ManualLayout, requestId: number): AssignmentLocation | null {
  for (const route of layout.routes) {
    const position = route.requestIds.indexOf(requestId);
    if (position >= 0) return { vehicleId: route.vehicleId, tripId: route.tripId, position };
  }
  return null;
}

/** Position is zero-based AFTER removal from the old trip. Never mutates input.
 * Idempotency and actor identity must be enforced by the eventual API publisher.
 * Empty routes are pruned only after the complete batch so intra-batch moves work.
 */
export function applyManualBatch(input: ManualLayout, batch: ManualBatch, actor: ManualActor): ManualLayout {
  assertManualLayout(input);
  requireThat(batch.datasetSha256 === input.datasetSha256, 'dataset changed');
  requireThat(typeof batch.operationId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(batch.operationId), 'operation identity required');
  requireThat(typeof actor.actorId === 'string' && actor.actorId.length > 0 && actor.actorId.length <= 128, 'actor required');
  requireThat(typeof actor.at === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(actor.at) && Number.isFinite(Date.parse(actor.at)), 'server timestamp required');
  requireThat(Array.isArray(batch.commands) && batch.commands.length > 0 && batch.commands.length <= 1000, 'invalid batch size');
  // Replays must be resolved transactionally against the stored payload/result,
  // not re-applied to a potentially different plan snapshot.
  requireThat(!input.history.some(event => event.operationId === batch.operationId), 'operation already applied');
  const next = structuredClone(input);
  for (const [index, command] of batch.commands.entries()) {
    requireThat(validId(command.requestId) && next.requestIds.includes(command.requestId), 'unknown request');
    requireThat(['assign', 'deassign', 'release'].includes(command.op), 'unknown manual command');
    const id = command.requestId, from = location(next, id);
    if (command.op !== 'release') {
      requireThat(!from || !next.lockedVehicleIds.includes(from.vehicleId), 'unlock source route first');
      if (command.op === 'assign') {
        requireThat(next.vehicleIds.includes(command.vehicleId), 'unknown target vehicle');
        requireThat(!next.excludedVehicleIds.includes(command.vehicleId), 'target vehicle is excluded');
        requireThat(!next.lockedVehicleIds.includes(command.vehicleId), 'unlock target route first');
        requireThat(validTrip(command.tripId), 'invalid target trip');
      }
      for (const route of next.routes) route.requestIds = route.requestIds.filter(value => value !== id);
      next.unassigned = next.unassigned.filter(value => value !== id);
      if (command.op === 'deassign') {
        next.unassigned.push(id);
        next.decisions[String(id)] = { kind: 'unassigned' };
      } else {
        let target = next.routes.find(route => route.vehicleId === command.vehicleId && route.tripId === command.tripId);
        if (!target) {
          target = { vehicleId: command.vehicleId, tripId: command.tripId, requestIds: [] };
          next.routes.push(target);
        }
        requireThat(Number.isSafeInteger(command.position) && command.position >= 0 && command.position <= target.requestIds.length, 'invalid insertion position');
        target.requestIds.splice(command.position, 0, id);
        next.decisions[String(id)] = { kind: 'vehicle', vehicleId: command.vehicleId };
      }
    } else {
      delete next.decisions[String(id)]; // does not move the actual assignment
    }
    // Preserve initial attribution, including explicit unknown historical origin.
    next.origins[String(id)] ??= 'historical';
    next.history.push({ operationId: batch.operationId, index, requestId: id, action: command.op,
      actorId: actor.actorId, at: actor.at, from, to: location(next, id) });
  }
  next.routes = next.routes.filter(route => route.requestIds.length > 0);
  assertManualLayout(next);
  return next;
}
