/** Pure, shared representation of the instructions applied on the next Replan. */
export interface InstructionState {
  removedVehicleIds:number[];
  pins:{orderNo:string;requestId?:number;vehicleId:number}[];
  forbids:{orderNo:string;requestId?:number;vehicleId:number}[];
  vehicleOverrides:{vehicleId:number;capacityKg?:number;capacityPallets?:number;shiftEarlySec?:number;shiftLateSec?:number;maxTrips?:number;maxDistanceKm?:number;maxDurationMin?:number}[];
  sequences:{vehicleId:number;orderNos:string[];requestIds?:number[];locked?:boolean}[];
}
export type Instruction =
 | {op:'removeVehicle';vehicleId:number}
 | {op:'pin'|'forbid';orderNo:string;requestId?:number;vehicleId:number}
 | {op:'setVehicleConstraint';vehicleId:number;patch:Record<string,number|undefined>}
 | {op:'setSequence';vehicleId:number;orderNos:string[];requestIds?:number[];locked:boolean};
export function instructions(s:InstructionState):Instruction[] {
  return [
    ...s.removedVehicleIds.map(vehicleId=>({op:'removeVehicle' as const,vehicleId})),
    ...s.pins.map(p=>({op:'pin' as const,...p})),
    ...s.forbids.map(p=>({op:'forbid' as const,...p})),
    ...s.vehicleOverrides.map(({vehicleId,...patch})=>({op:'setVehicleConstraint' as const,vehicleId,patch})),
    ...s.sequences.map(q=>({op:'setSequence' as const,...q,locked:!!q.locked})),
  ];
}
export function instructionKey(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(instructionKey).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${instructionKey(v)}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
export interface UndoInstruction {instruction:Instruction;datasetSha256?:string}
