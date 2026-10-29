import type { LoadedDay } from '../data/dataset.js';
import type { ApprovedProfile } from '../planning-profiles.js';
import { parseProfile, profileDigest } from '../planning-profiles.js';
import { manualSettings } from '../state/manual-settings.js';
import type { ManualDatasetContext } from './manual-adapter.js';

/** Apply only explicitly pinned, approved immutable revisions. Published input
 * objects and cached matrices are never rewritten. */
export function applyProfileSnapshots(original: LoadedDay, profiles: ApprovedProfile[], fallback?: Omit<ManualDatasetContext,'day'>) {
  const {travel,...mutable}=original.request;
  const day:LoadedDay={...original,request:{...structuredClone(mutable),travel},
    enrichment:new Map(original.enrichment),deliveryEnrichment:new Map(original.deliveryEnrichment)};
  let settings=fallback;
  const kinds=new Set<string>();
  for(const profile of profiles){
    const content=parseProfile(profile.content);
    if(!profile.approvedAt||!Number.isFinite(Date.parse(profile.approvedAt))||profileDigest(content)!==profile.sha256||
      profile.kind!==content.kind||kinds.has(content.kind)||content.datasetSha256!==day.datasetRequestSha256)
      throw new Error('Pinned profile integrity, approval or dataset mismatch.');
    kinds.add(content.kind);
    if(content.kind==='fleet'){
      settings=manualSettings(content.settings);
      const inventory=day.request.vehicles;
      if(settings.reloadSeconds.size!==inventory.length||inventory.some(v=>!settings!.reloadSeconds.has(v.id)))
        throw new Error('Profile fleet does not match the admitted vehicle inventory.');
      for(const vehicle of inventory){
        const info=settings.vehicleInfo.get(vehicle.ref.replace(/[^a-z0-9]/gi,'').toUpperCase());
        if(!info)throw new Error('Profile registration does not match the admitted vehicle.');
        vehicle.gross_weight_kg=info.tonnage===null?0:info.tonnage*1000;
        vehicle.has_tail_lift=info.hasTailLift;vehicle.trip_reload_seconds=settings.reloadSeconds.get(vehicle.id)!;
        const entry=content.settings!.vehicles.find(v=>v.id===vehicle.id)!;
        vehicle.capacity=[entry.capacityKg??vehicle.capacity[0]!,entry.capacityPallets??vehicle.capacity[1]!];
        if(entry.available!==false&&(info.tonnage===null||vehicle.capacity[0]!>info.tonnage*1000))throw new Error('Fleet profile payload exceeds verified GVW.');
        vehicle.approved_capacity=[...vehicle.capacity];
      }
    }else{
      const tasks=new Map(day.request.tasks.map(t=>[t.id,t]));
      const rules=new Map(content.locations!.map(rule=>[rule.locationId,rule]));
      for(const locationId of rules.keys())if(!day.request.locations[locationId])throw new Error('Unknown profile location.');
      const scopedRefs=new Map<string,number>();
      for(const order of day.request.requests){const task=tasks.get(order.delivery_task_id);if(task)scopedRefs.set(task.ref,(scopedRefs.get(task.ref)??0)+1);}
      for(const order of day.request.requests){
        const task=tasks.get(order.delivery_task_id),rule=task&&rules.get(task.location_id);
        if(!task||!rule)continue;
        const info=day.deliveryEnrichment!.get(order.id)??day.enrichment.get(task.ref);
        if(!info||!day.deliveryEnrichment!.has(order.id)&&(scopedRefs.get(task.ref)??0)>1&&!day.verifiedSharedAccessRefs?.has(task.ref))
          throw new Error('Location profile requires unambiguous delivery/source evidence.');
        const effective={...info,maxTonnage:rule.maxGrossWeightKg===null?null:rule.maxGrossWeightKg/1000,requiresTailLift:rule.requiresTailLift};
        day.deliveryEnrichment!.set(order.id,effective);
        task.service_seconds=rule.serviceSeconds;task.tw_early=rule.windowStartSeconds;task.tw_late=rule.windowEndSeconds;
      }
    }
  }
  day.planningProfiles=profiles.map(({id,kind,revision,sha256})=>({id,kind,revision,sha256}));
  return {day,settings};
}
