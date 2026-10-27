import type { ManualDatasetContext } from '../plan/manual-adapter.js';
import type { SurgeRequest } from '../types.js';
import type { Plan } from '../types.js';
import { tariffIdentity } from '../cost.js';
/** External, non-secret operational settings; no implicit reload/fleet guesses. */
export function manualSettings(value: unknown): Omit<ManualDatasetContext,'day'> {
  const data=value as {datasetSha256?:string;tariff?:ManualDatasetContext['tariff'];vehicles?:{id:number;ref:string;vehicleClass:string|null;isSubcontractor:boolean;tonnage:number|null;hasTailLift:boolean;reloadSec:number;available?:boolean}[]};
  if (!data || !Array.isArray(data.vehicles) || !data.vehicles.length || !data.tariff || !['per_trip','per_vehicle'].includes(data.tariff.model)) throw new Error('Invalid manual planning settings');
  if(data.datasetSha256!==undefined&&!/^[a-f0-9]{64}$/.test(data.datasetSha256))throw new Error('Invalid settings dataset identity');
  const t=data.tariff,nonnegative=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  if(!/^[A-Z]{3}$/.test(t.currency)||!['demo','external'].includes(t.source)||
    ![t.perKmDefault,t.fixedPerVehicle,t.perTripBase,t.perKm,t.perDrop,t.includedDrops,t.subcontractorMultiplier,t.ownFleetMultiplier].every(nonnegative)||
    ![t.perKmByClass,t.fixedByClass].every(table=>table&&typeof table==='object'&&!Array.isArray(table)&&Object.values(table).every(nonnegative)))
    throw new Error('Invalid manual tariff settings');
  const vehicleInfo:ManualDatasetContext['vehicleInfo']=new Map(),reloadSeconds=new Map<number,number>(),unavailableVehicleIds:number[]=[];
  for(const v of data.vehicles){
    if(!v)throw new Error('Invalid manual fleet settings');
    const key=typeof v.ref==='string'?v.ref.replace(/[^a-z0-9]/gi,'').toUpperCase():'';
    if(!key||!Number.isSafeInteger(v.id)||v.id<0||reloadSeconds.has(v.id)||vehicleInfo.has(key)||
      typeof v.hasTailLift!=='boolean'||typeof v.isSubcontractor!=='boolean'||v.available!==undefined&&typeof v.available!=='boolean'||!Number.isSafeInteger(v.reloadSec)||v.reloadSec<0||v.reloadSec>2147483647||
      v.vehicleClass!==null&&typeof v.vehicleClass!=='string'||
      v.tonnage!==null&&(!Number.isFinite(v.tonnage)||v.tonnage<=0))throw new Error('Invalid manual fleet settings');
    vehicleInfo.set(key,{plate:v.ref,vehicleClass:v.vehicleClass,isSubcontractor:v.isSubcontractor,tonnage:v.tonnage,hasTailLift:v.hasTailLift});
    reloadSeconds.set(v.id,v.reloadSec);
    if(v.available===false)unavailableVehicleIds.push(v.id);
  }
  return {vehicleInfo,reloadSeconds,tariff:data.tariff,unavailableVehicleIds,...(data.datasetSha256?{datasetSha256:data.datasetSha256}:{})};
}

/** Apply a verified, dataset-scoped policy before native overrides/constraints.
 * Validate the entire inventory first; never copy a different fleet's defaults. */
export function applyFleetSettings(request:SurgeRequest,datasetSha256:string|undefined,settings:Omit<ManualDatasetContext,'day'>):boolean {
  if(settings.datasetSha256&&settings.datasetSha256!==datasetSha256)return false;
  const ids=new Set(request.vehicles.map(v=>v.id));
  if(ids.size!==request.vehicles.length||settings.reloadSeconds.size!==ids.size||
    (settings.unavailableVehicleIds??[]).some(id=>!ids.has(id)))throw new Error('Fleet settings inventory mismatch');
  for(const v of request.vehicles){
    const info=settings.vehicleInfo.get(v.ref.replace(/[^a-z0-9]/gi,'').toUpperCase()),reload=settings.reloadSeconds.get(v.id);
    if(!info||typeof reload!=='number'||!Number.isSafeInteger(reload)||reload<0||reload>2147483647||
      typeof info.hasTailLift!=='boolean'||typeof info.isSubcontractor!=='boolean'||
      info.tonnage!==null&&(!Number.isFinite(info.tonnage)||info.tonnage<=0)||
      v.gross_weight_kg!==undefined&&v.gross_weight_kg!==(info.tonnage===null?0:info.tonnage*1000)||
      v.has_tail_lift!==undefined&&v.has_tail_lift!==info.hasTailLift||
      v.trip_reload_seconds!==undefined&&v.trip_reload_seconds!==reload)throw new Error('Fleet settings evidence mismatch');
  }
  for(const v of request.vehicles){
    const info=settings.vehicleInfo.get(v.ref.replace(/[^a-z0-9]/gi,'').toUpperCase())!;
    v.gross_weight_kg=info.tonnage===null?0:info.tonnage*1000;
    v.has_tail_lift=info.hasTailLift;v.trip_reload_seconds=settings.reloadSeconds.get(v.id)!;
  }
  return true;
}

/** Pure approval/export check: no object-store calls while holding DB locks. */
export function fleetPolicyBlockers(plan:Plan,settings:Omit<ManualDatasetContext,'day'>):string[] {
  const sha=plan.provenance.datasetSha256??plan.provenance.planningPolicy?.datasetRequestSha256;
  if(settings.datasetSha256&&sha&&settings.datasetSha256!==sha)return [];
  if(settings.datasetSha256&&!sha)return ['Fleet policy dataset identity is missing; create a fresh plan before approval.'];
  const changed=plan.provenance.tariffSha256!==tariffIdentity(settings.tariff)||plan.vehicles.some(vehicle=>{
    const info=settings.vehicleInfo.get(vehicle.ref.replace(/[^a-z0-9]/gi,'').toUpperCase());
    return !info||settings.unavailableVehicleIds?.includes(vehicle.id)||info.tonnage!==vehicle.tonnage||
      info.hasTailLift!==vehicle.hasTailLift||info.vehicleClass!==vehicle.vehicleClass||info.isSubcontractor!==vehicle.isSubcontractor;
  });
  return changed?['Fleet or tariff settings changed; create and validate a fresh plan before approval.']:[];
}
