type Delivery = {orderNo:string;requestId?:number};
export interface ComparisonInput {day:string;stats:{servedOrders:number;totalOrders:number};vehicles:{trips:{stops:Delivery[]}[]}[];unassigned:Delivery[];
 cost:{currency:string}|null;provenance:{datasetSha256?:string;shipmentSha256?:string;tariffSha256?:string;planningPolicy?:unknown;planningProfiles?:unknown}}
export const datasetIdentity = (p: ComparisonInput): string | undefined => {
 const policy=p.provenance?.planningPolicy;
 return p.provenance?.datasetSha256??(policy&&typeof policy==='object'&&'datasetRequestSha256' in policy&&typeof policy.datasetRequestSha256==='string'?policy.datasetRequestSha256:undefined);
};
const all = (p: ComparisonInput): Delivery[] => [...p.vehicles.flatMap(v => v.trips.flatMap(t => t.stops)), ...p.unassigned];
export function deliveryComparison(base: ComparisonInput, revised: ComparisonInput) {
  const before = all(base), after = all(revised);
  const stable = [...before, ...after].every(s => Number.isSafeInteger(s.requestId) && s.requestId! >= 0);
  const unique = (rows: Delivery[], key: (s: Delivery) => string) => new Set(rows.map(key)).size === rows.length;
  const key = (s: Delivery): string => stable ? `id:${s.requestId}` : `ref:${s.orderNo}`;
  const unambiguous = unique(before, key) && unique(after, key);
  const a = new Set(before.map(key)), b = new Set(after.map(key));
  const dataset = datasetIdentity(base), other = datasetIdentity(revised);
  const sameDataset = Boolean(dataset && other && dataset === other);
  const compatibleNamespace = stable ? sameDataset : !(dataset && other && dataset !== other);
  const sameScope = base.day === revised.day && unambiguous && compatibleNamespace && a.size > 0 &&
    before.length === base.stats.totalOrders && after.length === revised.stats.totalOrders &&
    a.size === b.size && [...a].every(id => b.has(id));
  const servedBefore = base.vehicles.flatMap(v => v.trips.flatMap(t => t.stops));
  const servedAfter = new Set(revised.vehicles.flatMap(v => v.trips.flatMap(t => t.stops)).map(key));
  const lostService = revised.stats.servedOrders < base.stats.servedOrders || unambiguous && compatibleNamespace && servedBefore.some(s => !servedAfter.has(key(s)));
  return { key, unambiguous, sameScope, sameDataset, comparablePlacements: unambiguous && compatibleNamespace, lostService,
    verifiedScope: stable && sameDataset && sameScope };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function comparisonEvidence(base: ComparisonInput, revised: ComparisonInput) {
  const identity = deliveryComparison(base, revised);
  const tariff = base.provenance?.tariffSha256, other = revised.provenance?.tariffSha256;
  const sameTariff = Boolean(tariff && other && tariff === other && base.cost?.currency === revised.cost?.currency);
  const samePolicy = canonical([base.provenance?.planningPolicy??null,base.provenance?.planningProfiles??[]]) ===
    canonical([revised.provenance?.planningPolicy??null,revised.provenance?.planningProfiles??[]]);
  const sameMetadata=base.provenance?.shipmentSha256===revised.provenance?.shipmentSha256;
  return { ...identity, sameTariff, samePolicy,
    improvementEligible: identity.verifiedScope && sameTariff && samePolicy && sameMetadata && !identity.lostService };
}

export function tripPermutation(stops:Delivery[],orderNos:string[],requestIds?:unknown):boolean {
 if(!stops.length||stops.length!==orderNos.length)return false;
 if(requestIds!==undefined){
  if(!Array.isArray(requestIds)||requestIds.length!==stops.length||!requestIds.every(id=>Number.isSafeInteger(id)&&id>=0)||new Set(requestIds).size!==stops.length)return false;
  const byId=new Map(stops.map(s=>[s.requestId,s.orderNo]));
  return byId.size===stops.length&&!byId.has(undefined)&&requestIds.every((id,i)=>byId.get(id)===orderNos[i]);
 }
 const refs=new Set(stops.map(s=>s.orderNo));
 return refs.size===stops.length&&new Set(orderNos).size===stops.length&&orderNos.every(ref=>refs.has(ref));
}
