import type { ManualIntent } from '../types';

/** The UI position is in the destination AFTER all selected stops are removed.
 * API commands instead remove one stop at a time. Insert backwards before a
 * stable successor so same-trip bulk moves preserve the user's chosen order. */
export function manualAssignmentCommands(requestIds: number[], vehicleId: number, tripId: string,
  current: number[], position: number): ManualIntent['batch']['commands'] {
  if (new Set(requestIds).size !== requestIds.length || new Set(current).size !== current.length)
    throw new Error('Duplicate manual assignment identity');
  const selected = new Set(requestIds);
  const remaining = current.filter(id => !selected.has(id));
  if (!Number.isSafeInteger(position) || position < 0 || position > remaining.length)
    throw new Error('Invalid manual insertion position');
  let successor = remaining[position];
  let working = [...current];
  const commands: ManualIntent['batch']['commands'] = [];
  for (const requestId of [...requestIds].reverse()) {
    working = working.filter(id => id !== requestId);
    const index = successor === undefined ? working.length : working.indexOf(successor);
    if (index < 0) throw new Error('Missing manual insertion anchor');
    commands.push({ op: 'assign', requestId, vehicleId, tripId, position: index });
    working.splice(index, 0, requestId);
    successor = requestId;
  }
  return commands;
}
