import type { ManualDatasetContext } from '../plan/manual-adapter.js';
/** External, non-secret operational settings; no implicit reload/fleet guesses. */
export function manualSettings(value: unknown): Omit<ManualDatasetContext,'day'> {
  const data=value as {tariff?:ManualDatasetContext['tariff'];vehicles?:{id:number;ref:string;vehicleClass:string|null;isSubcontractor:boolean;tonnage:number|null;hasTailLift:boolean;reloadSec:number}[]};
  if (!data || !Array.isArray(data.vehicles) || !data.tariff || !['per_trip','per_vehicle'].includes(data.tariff.model)) throw new Error('Invalid manual planning settings');
  const vehicleInfo:ManualDatasetContext['vehicleInfo']=new Map(),reloadSeconds=new Map<number,number>();
  for(const v of data.vehicles){
    const key=typeof v.ref==='string'?v.ref.replace(/[^a-z0-9]/gi,'').toUpperCase():'';
    if(!key||!Number.isSafeInteger(v.id)||v.id<0||reloadSeconds.has(v.id)||vehicleInfo.has(key)||
      typeof v.hasTailLift!=='boolean'||typeof v.isSubcontractor!=='boolean'||!Number.isFinite(v.reloadSec)||v.reloadSec<0||
      v.tonnage!==null&&(!Number.isFinite(v.tonnage)||v.tonnage<=0))throw new Error('Invalid manual fleet settings');
    vehicleInfo.set(key,{plate:v.ref,vehicleClass:v.vehicleClass,isSubcontractor:v.isSubcontractor,tonnage:v.tonnage,hasTailLift:v.hasTailLift});
    reloadSeconds.set(v.id,v.reloadSec);
  }
  return {vehicleInfo,reloadSeconds,tariff:data.tariff};
}
