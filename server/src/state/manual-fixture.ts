/** Non-confidential deterministic fixture for manual adapter/publication tests. */
import type { LoadedDay, OrderInfo, VehicleInfo } from '../data/dataset.js';
import type { Scenario } from '../store.js';
import type { ManualDatasetContext } from '../plan/manual-adapter.js';
import type { SurgeRequest } from '../types.js';
import { mapSolutionToPlan } from '../plan/mapper.js';

export function manualFixture() {
  const scenario: Scenario = { id: 'manual-scenario', day: 'manual-day', kind: 'copy', parentId: null, revision: 1,
    label: 'Manual test', createdAt: '2026-10-26T00:00:00Z', removedVehicleIds: [], pins: [], forbids: [], sequences: [], vehicleOverrides: [] };
  const request: SurgeRequest = { config: {}, dimension_count: 2, demand_sign_convention: 1,
    locations: [{x:0,y:0},{x:1,y:1},{x:2,y:2}], depots: [{location_id:0}],
    vehicles: [7,42].map(id => ({id,ref:`V${id}`,capacity:[1000,10],start_depot_id:0,end_depot_id:0,gross_weight_kg:12000,has_tail_lift:true})),
    tasks: [1,2].map(id => ({id,ref:`ORDER-${id}`,type:'delivery',location_id:id,tw_early:0,tw_late:10000,service_seconds:60,demand:[100,1]})),
    requests: [{id:91,delivery_task_id:1},{id:92,delivery_task_id:2}],
    travel: {location_count:3,distances:[0,1000,2000,1000,0,1500,2000,1500,0],durations:[0,100,200,100,0,150,200,150,0]} };
  const enrichment = new Map<string,OrderInfo>([1,2].map(id => [`ORDER-${id}`, { id:`public-${id}`,orderNo:`ORDER-${id}`,customer:'Public fixture',city:'Test',
    street:null,zip:null,lat:id,lon:id,pallets:1,weightKg:100,twStart:null,twEnd:null,serviceMin:1,requiresTailLift:false,maxTonnage:null }]));
  const vehicleInfo = new Map<string,VehicleInfo>([7,42].map(id => [`V${id}`,{vehicleClass:null,plate:`V${id}`,isSubcontractor:false,tonnage:12,hasTailLift:true}]));
  const solution = {status:'OK',stats:{total_distance:4500,trips:1,vehicles_used:1},unassigned:[],routes:[{vehicle_id:7,distance:4500,duration:570,trip_count:1,
    stops:[{request_id:91,task_id:1,type:'delivery',trip_index:0,arrival:100,service_start:100,departure:160},
      {request_id:92,task_id:2,type:'delivery',trip_index:0,arrival:310,service_start:310,departure:370}]}]};
  const day: LoadedDay = { def:{id:scenario.day,date:'2026-10-26',isoDate:'2026-10-26',label:'Public',requestFile:'',solutionFile:''},
    kind:'uploaded',datasetRequestSha256:'a'.repeat(64),request,solution,scopeTaskIds:new Set([1,2]),
    depot:{name:'Depot',lon:0,lat:0},enrichment };
  const context: ManualDatasetContext = {day,vehicleInfo,reloadSeconds:new Map([[7,120],[42,120]]),
    tariff:{currency:'HUF',source:'demo',model:'per_vehicle',perKmDefault:10,fixedPerVehicle:1000,perKmByClass:{},fixedByClass:{},
      perTripBase:500,perKm:10,perDrop:50,includedDrops:0,subcontractorMultiplier:1,ownFleetMultiplier:1}};
  const parent = mapSolutionToPlan({day,request,solution,enrichment,vehicleInfo,scenarioId:scenario.id,scenarioRevision:1,
    planId:'manual-parent',source:'live',createdAt:'2026-10-26T00:00:00Z'});
  return { scenario, parent, context };
}
