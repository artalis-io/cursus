/** V2 admission and independent BigInt replay. This never searches for a load
 * or asks the solver to repair evidence at the authoritative write boundary. */
import type {LoadingDocument,PhysicalAxles,PhysicalVehicle,PhysicalUnit,LoadingRound,LoadingCapability,NativeLoadingCapabilities,LoadingRequirement} from './loading-contract.js';
import type {PlanStop} from './types.js';
const need=(v:unknown,m:string):void=>{if(!v)throw Error('Physical loading: '+m);};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,names:string[]):v is Record<string,unknown>=>object(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const int=(v:unknown,min=0,max=1000000000):v is number=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
export const AXLE_CAPABILITIES:readonly LoadingCapability[]=Object.freeze(['stacking','axle_loads']);
export function sameCapabilities(a:unknown,b:readonly string[]):boolean{return Array.isArray(a)&&a.length===b.length&&new Set(a).size===a.length&&a.every(x=>typeof x==='string'&&b.includes(x));}
const interval=(v:unknown):boolean=>exact(v,['min','max'])&&int(v.min)&&int(v.max)&&v.min<=v.max;
const signed=(v:unknown):boolean=>exact(v,['min','max'])&&int(v.min,-1000000,1000000)&&int(v.max,-1000000,1000000)&&v.min<=v.max;
export function validateAxleFacts(facts:LoadingDocument):void {
 need(facts.schemaVersion===2&&sameCapabilities(facts.requiredCapabilities,AXLE_CAPABILITIES),'unsupported V2 capabilities');
 let minFootprint=1000000;
 for(const v of facts.vehicles){
  const a=v.axles;
  need(exact(a,['model','profileSha256','wheelbaseMm','footprintLengthMm','deckMinMm','deckMaxMm','slotCentresMm','frontTareG','rearTareG','frontLimitsG','rearLimitsG','maxGrossG','minFrontFraction']),'complete axle facts required');
  if(!a)throw Error('Physical loading: axle facts required');
  need(a.model==='rigid_two_axle_v1'&&/^[a-f0-9]{64}$/.test(a.profileSha256),'unsupported axle model/profile');
  need(int(a.wheelbaseMm,1,1000000)&&int(a.footprintLengthMm,1,1000000)&&int(a.deckMinMm,-1000000,1000000)&&int(a.deckMaxMm,-1000000,1000000)&&a.deckMinMm<a.deckMaxMm,'invalid axle geometry');
  need([a.frontTareG,a.rearTareG,a.frontLimitsG,a.rearLimitsG].every(interval)&&int(a.maxGrossG),'invalid tare/axle/gross intervals');
  need(a.minFrontFraction===null||exact(a.minFrontFraction,['numerator','denominator'])&&int(a.minFrontFraction.numerator,0,1000000)&&int(a.minFrontFraction.denominator,1,1000000)&&a.minFrontFraction.numerator<=a.minFrontFraction.denominator,'explicit front fraction or null required');
  need(Array.isArray(a.slotCentresMm)&&a.slotCentresMm.length===v.slotCount,'slot centre inventory mismatch');
  a.slotCentresMm.forEach((x,i)=>{
   need(int(x,-1000000,1000000)&&2*x-a.footprintLengthMm>=2*a.deckMinMm&&2*x+a.footprintLengthMm<=2*a.deckMaxMm,'slot outside declared deck');
   for(let j=0;j<i;j++)if(v.slots[i]!.lane===v.slots[j]!.lane){
    need(Math.abs(x-a.slotCentresMm[j]!)>=a.footprintLengthMm&&v.slots[i]!.depth!==v.slots[j]!.depth,'overlapping lane slots');
    if(v.access==='rear_lifo')need((v.slots[i]!.depth<v.slots[j]!.depth)===(x>a.slotCentresMm[j]!), 'rear access/metric geometry disagree');
   }
  });
  minFootprint=Math.min(minFootprint,a.footprintLengthMm);
 }
 for(const r of facts.requests)for(const u of r.units)need(signed(u.cgOffsetMm)&&2*u.cgOffsetMm!.min>=-minFootprint&&2*u.cgOffsetMm!.max<=minFootprint,'CG must lie inside declared footprint');
}
export function requireNativeCapabilities(value:unknown,nodeBudget=10000):asserts value is NativeLoadingCapabilities {
 const implemented=object(value)&&Array.isArray(value.implemented_capabilities)?value.implemented_capabilities:[];
 need(object(value)&&value.schema_version===2&&Array.isArray(value.implemented_capabilities)&&new Set(implemented).size===implemented.length&&implemented.every(v=>typeof v==='string')&&Array.isArray(value.handling_models)&&AXLE_CAPABILITIES.every(c=>implemented.includes(c))&&Array.isArray(value.axle_models)&&value.axle_models.includes('rigid_two_axle_v1')&&object(value.limits),'native worker lacks required axle capabilities');
 const caps=value as unknown as NativeLoadingCapabilities;
 need(int(caps.limits.max_nodes, nodeBudget,1000000000)&&int(caps.limits.max_units,128,1000000000)&&int(caps.limits.max_slots,128,1000000000)&&int(caps.limits.max_layers,8,1000000000)&&int(caps.limits.max_stops,100000,1000000000),'native capability limits insufficient');
}
export function factRequirement(facts:LoadingDocument,sourceSha256:string):LoadingRequirement {
 return {version:facts.schemaVersion,sourceSha256,requiredCapabilities:facts.schemaVersion===2?[...AXLE_CAPABILITIES]:['stacking']};
}
/** Validate a durable queue/manifest requirement; never accept a request-body downgrade. */
export function validateRequirement(v:unknown):asserts v is LoadingRequirement {
 need(exact(v,['version','sourceSha256','requiredCapabilities'])&&(v.version===1||v.version===2)&&typeof v.sourceSha256==='string'&&/^[a-f0-9]{64}$/.test(v.sourceSha256)&&sameCapabilities(v.requiredCapabilities,v.version===2?AXLE_CAPABILITIES:['stacking']),'invalid durable loading requirement');
}

function reactions(a:PhysicalAxles,units:(PhysicalUnit&{stop:number})[],places:{slot:number;layer:number}[],active:Set<number>,step:number,reported:NonNullable<LoadingRound['axle_states']>[number]):void {
 const L=BigInt(a.wheelbaseMm);let mass=0n,minMoment=0n,maxMoment=0n;
 for(const i of active){const u=units[i]!,w=BigInt(u.weightG),x=BigInt(a.slotCentresMm[places[i]!.slot]!);mass+=w;minMoment+=w*(x+BigInt(u.cgOffsetMm!.min));maxMoment+=w*(x+BigInt(u.cgOffsetMm!.max));}
 const frontMin=(BigInt(a.frontTareG.min)+mass)*L-maxMoment,frontMax=(BigInt(a.frontTareG.max)+mass)*L-minMoment;
 const rearMin=BigInt(a.rearTareG.min)*L+minMoment,rearMax=BigInt(a.rearTareG.max)*L+maxMoment;
 const grossMin=BigInt(a.frontTareG.min)+BigInt(a.rearTareG.min)+mass,grossMax=BigInt(a.frontTareG.max)+BigInt(a.rearTareG.max)+mass;
 need(frontMin>=BigInt(a.frontLimitsG.min)*L&&frontMax<=BigInt(a.frontLimitsG.max)*L&&rearMin>=BigInt(a.rearLimitsG.min)*L&&rearMax<=BigInt(a.rearLimitsG.max)*L&&grossMax<=BigInt(a.maxGrossG),'axle or gross limit exceeded');
 if(a.minFrontFraction){const f=a.minFrontFraction;need(frontMin*BigInt(f.denominator)>=(BigInt(a.frontTareG.min)+BigInt(a.rearTareG.max)+mass)*L*BigInt(f.numerator),'minimum front load fraction exceeded');}
 need(reported&&reported.step===step&&reported.gross_min_g===Number(grossMin)&&reported.gross_max_g===Number(grossMax),'axle state inventory/gross mismatch');
 for(const [key,num] of Object.entries({front_min_g:frontMin,front_max_g:frontMax,rear_min_g:rearMin,rear_max_g:rearMax})){
  const r=reported[key as 'front_min_g'];need(r&&typeof r.numerator==='string'&&/^(0|-?[1-9][0-9]{0,18})$/.test(r.numerator)&&r.denominator===a.wheelbaseMm&&BigInt(r.numerator)===num,'exact axle reaction mismatch');
 }
}
export function replayAxleRound(vehicle:PhysicalVehicle,units:(PhysicalUnit&{stop:number})[],ids:string[],round:LoadingRound,stops:PlanStop[],facts:LoadingDocument,
 stackReplay:(v:PhysicalVehicle,u:(PhysicalUnit&{stop:number})[],p:{slot:number;layer:number}[])=>void):void {
 const a=vehicle.axles!;const n=units.length;
 need(n<=128&&Array.isArray(round.operations)&&round.operations.length===2*n&&Array.isArray(round.axle_states)&&round.axle_states.length===2*n+1&&Array.isArray(round.stops)&&round.stops.length===stops.length,'complete operation/state/stop evidence required');
 need(round.extra_moves===0&&round.extra_service_sec===0&&round.extra_fee_units===0,'unexpected reshuffling charges');
 const supplied=new Map(round.placements.map(p=>[p.request_id+':'+p.unit_index,p]));const places=ids.map(id=>supplied.get(id)!);
 const active=new Set<number>(),loaded=new Set<number>();
 const check=(step:number)=>{const remaining=[...active];stackReplay({...vehicle,access:'side_free'},remaining.map(i=>units[i]!),remaining.map(i=>places[i]!));reactions(a,units,places,active,step,round.axle_states![step]!);};
 check(0);let lastStop=0;
 round.operations!.forEach((op,step)=>{
  need(exact(op,['kind','stop_index','request_id','unit_index','slot','layer']),'malformed operation');
  need([op.request_id,op.unit_index,op.slot,op.layer].every(v=>int(v,0,Number.MAX_SAFE_INTEGER)),'invalid operation identity');
  const i=ids.indexOf(op.request_id+':'+op.unit_index);need(i>=0,'foreign operation unit');const p=places[i]!;
  need(op.slot===p.slot&&op.layer===p.layer,'operation/placement mismatch');
  need(![...active].some(j=>places[j]!.slot===p.slot&&places[j]!.layer>p.layer),'upper unit blocks operation');
  if(vehicle.access==='rear_lifo'){const target=vehicle.slots[p.slot]!;need(![...active].some(j=>j!==i&&vehicle.slots[places[j]!.slot]!.lane===target.lane&&vehicle.slots[places[j]!.slot]!.depth<target.depth),'nearer slot blocks operation');}
  if(step<n){need(op.kind==='load'&&op.stop_index===null&&!loaded.has(i),'invalid depot loading order');loaded.add(i);active.add(i);}
  else {need(op.kind==='deliver'&&op.stop_index===units[i]!.stop&&op.stop_index>=lastStop&&active.has(i)&&![...active].some(j=>units[j]!.stop<op.stop_index!),'invalid delivery operation');lastStop=op.stop_index!;active.delete(i);}
  check(step+1);
 });
 need(active.size===0&&loaded.size===n,'incomplete delivery inventory');
 round.stops!.forEach((s,i)=>{const stop=stops[i]!,source=facts.requests.find(r=>r.requestId===stop.requestId);need(source&&s.stop_index===i&&s.task_id===source.deliveryTaskId&&[s.arrival_sec,s.service_start_sec,s.departure_sec,s.base_service_sec].every(v=>typeof v==='number'&&Number.isFinite(v))&&s.arrival_sec===stop.arrivalSec&&s.service_start_sec===stop.serviceStartSec&&s.departure_sec===stop.departureSec&&Number.isSafeInteger(s.base_service_sec)&&s.base_service_sec===Math.round(stop.serviceMin*60)&&s.extra_moves===0&&s.extra_service_sec===0&&s.extra_fee_units===0,'loading schedule does not match plan');});
}
export function sameRequirement(a:unknown,b:unknown):boolean {
 validateRequirement(a);validateRequirement(b);
 return a.version===b.version&&a.sourceSha256===b.sourceSha256&&sameCapabilities(a.requiredCapabilities,b.requiredCapabilities);
}
export function assertAxleFleetLimits(facts:LoadingDocument,vehicles:{id:number;gross_weight_kg?:number}[]):void {
 if(facts.schemaVersion!==2)return;
 for(const vehicle of vehicles){const a=facts.vehicles.find(v=>v.vehicleId===vehicle.id)?.axles;const gross=vehicle.gross_weight_kg;
  if(a&&typeof gross==='number'&&Number.isFinite(gross)&&gross>0)need(a.maxGrossG<=Math.floor(gross*1000),'axle gross limit exceeds approved fleet GVW; update verified facts');
 }
}
