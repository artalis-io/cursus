import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateManualLayout, type ManualEvaluationInput } from './manual-evaluate.js';
import { applyManualBatch } from './manual.js';

function fixture(): ManualEvaluationInput {
  return {
    datasetSha256: 'a'.repeat(64), tariffSha256: 'b'.repeat(64),
    layout: { datasetSha256: 'a'.repeat(64), requestIds: [91, 92], vehicleIds: [7, 42], excludedVehicleIds: [], lockedVehicleIds: [],
      routes: [{ vehicleId: 7, tripId: 'first', requestIds: [91] }, { vehicleId: 7, tripId: 'second', requestIds: [92] }],
      unassigned: [], decisions: {}, origins: {}, history: [] },
    request: { config: {}, dimension_count: 2, demand_sign_convention: 1,
      locations: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], depots: [{ location_id: 0 }],
      vehicles: [7, 42].map(id => ({ id, ref: `V-${id}`, capacity: [1000, 10], start_depot_id: 0, end_depot_id: 0, max_trips: 0 })),
      tasks: [1, 2].map(id => ({ id, ref: 'REPEATED-DISPLAY-NUMBER', type: 'delivery', location_id: id,
        tw_early: 0, tw_late: 10000, service_seconds: 60, demand: [100, 1] })),
      requests: [{ id: 91, delivery_task_id: 1 }, { id: 92, delivery_task_id: 2 }],
      travel: { location_count: 3, distances: [0,1000,2000,1000,0,1500,2000,1500,0], durations: [0,100,200,100,0,150,200,150,0] } },
    requirements: new Map([91,92].map(id => [id, { maxTonnage: null, requiresTailLift: false }])),
    fleet: new Map([7,42].map(id => [id, { grossTonnage: 12, hasTailLift: true, vehicleClass: null, isSubcontractor: false, reloadSec: 120 }])),
    departures: new Map([['7:first',0],['7:second',0],['42:new',0]]),
    tariff: { currency: 'HUF', source: 'demo', model: 'per_vehicle', perKmDefault: 10, fixedPerVehicle: 1000,
      perKmByClass: {}, fixedByClass: {}, perTripBase: 500, perKm: 10, perDrop: 50, includedDrops: 0,
      subcontractorMultiplier: 1, ownFleetMultiplier: 1 },
  };
}

test('independent exact fixture: later trips, reload, repeated refs, fixed cost once', () => {
  const input = fixture(), before = structuredClone(input), out = evaluateManualLayout(input);
  assert.equal(out.validation.valid, true);
  assert.deepEqual(out.stats, { totalOrders: 2, servedOrders: 2, unassignedOrders: 0, vehiclesUsed: 1, trips: 2, totalDistanceKm: 6 });
  assert.deepEqual(out.cost, { total: 1060, fixed: 1000, variable: 60, currency: 'HUF', source: 'demo' });
  const trips = out.vehicles[0]!.trips;
  assert.deepEqual(trips.map(t => [t.startSec,t.endSec,t.distanceKm,t.cost]), [[0,260,2,520],[380,840,4,540]]);
  assert.deepEqual(trips.flatMap(t => t.stops.map(s => s.requestId)), [91,92]);
  assert.deepEqual(input,before);
});

test('moving work recomputes both vehicles and subsequent trip departure', () => {
  const input = fixture();
  input.layout = applyManualBatch(input.layout, { operationId: 'move', datasetSha256: input.datasetSha256,
    commands: [{ op: 'assign', requestId: 91, vehicleId: 42, tripId: 'new', position: 0 }] }, { actorId: 'planner', at: '2026-10-26T00:00:00Z' });
  const out = evaluateManualLayout(input);
  assert.equal(out.stats.vehiclesUsed,2);
  assert.equal(out.cost.total,2060);
  assert.equal(out.vehicles[0]!.trips[0]!.startSec,0);
  assert.equal(out.vehicles[0]!.trips[0]!.endSec,460);
});

test('combining stops changes total distance and trips without ambiguous display IDs', () => {
  const input = fixture();
  input.layout.routes = [{ vehicleId: 7, tripId: 'first', requestIds: [91,92] }];
  const out = evaluateManualLayout(input);
  assert.equal(out.stats.totalDistanceKm,4.5);
  assert.equal(out.stats.trips,1);
  assert.equal(out.cost.total,1045);
  assert.equal(out.vehicles[0]!.trips[0]!.endSec,570);
});

test('empty vehicles and all-unassigned drafts have zero costs, not phantom trips', () => {
  const input = fixture(); input.layout.routes=[]; input.layout.unassigned=[91,92];
  const out = evaluateManualLayout(input);
  assert.equal(out.cost.total,0); assert.equal(out.stats.servedOrders,0);
  assert.equal(out.stats.totalOrders,2); assert.equal(out.stats.unassignedOrders,2);
  assert.equal(out.stats.vehiclesUsed,0); assert.equal(out.stats.trips,0);
});

test('per-trip tariff and fractional rounding reconcile trip, vehicle and total costs', () => {
  const input = fixture(); input.tariff.model='per_trip';
  input.tariff.ownFleetMultiplier=1.003;
  const out = evaluateManualLayout(input), trips=out.vehicles[0]!.trips;
  // (2*500 + 6*10 + 2*50) * 1.003, fixed and variable rounded separately.
  assert.equal(out.cost.fixed,1003); assert.equal(out.cost.variable,160);
  assert.equal(out.cost.total,1163);
  assert.equal(trips.reduce((n,t) => n+t.cost,0),1163);
});

test('wait/service start drives hard deadline checks, not early arrival alone', () => {
  const input=fixture(); input.request.tasks[0]!.tw_early=200; input.request.tasks[0]!.tw_late=150;
  const out=evaluateManualLayout(input), stop=out.vehicles[0]!.trips[0]!.stops[0]!;
  assert.equal(stop.arrivalSec,100); assert.equal(stop.serviceStartSec,200);
  assert.equal(stop.waitSec,100); assert.equal(stop.lateSec,50);
  assert.equal(out.validation.valid,false);
  assert.ok(out.validation.violations.some(v => v.type==='HARD_TW' && v.requestId===91));
});

test('every supported hard constraint produces invalid draft evidence without dropping work', () => {
  const input=fixture(), vehicle=input.request.vehicles[0]!;
  vehicle.capacity=[99,0]; vehicle.shift_late=100; vehicle.max_trips=1; vehicle.max_distance=1000; vehicle.max_duration=100;
  input.requirements.set(91,{maxTonnage:3.5,requiresTailLift:true});
  input.fleet.get(7)!.hasTailLift=false;
  input.layout.excludedVehicleIds=[7]; input.request.requests[0]!.forbidden_vehicles=[7];
  const out=evaluateManualLayout(input);
  assert.deepEqual(new Set(out.validation.violations.map(v => v.type)), new Set(['CAPACITY','SHIFT','MAX_TRIPS','MAX_DISTANCE','MAX_DURATION','VEHICLE_SIZE','TAIL_LIFT','EXCLUDED','ASSIGNMENT']));
  assert.equal(out.stats.servedOrders,2); assert.equal(out.validation.valid,false);
  assert.ok(out.validation.violations.every(v => v.soft===false));
});

test('missing routing or safety facts fail closed rather than report zero or valid', () => {
  const changes: ((x: ManualEvaluationInput)=>void)[] = [
    x => { x.request.travel.distances[1]=NaN; }, x => { x.request.travel.durations[1]=-1; },
    x => { x.request.travel.distances.pop(); }, x => { x.request.travel.location_count=4; },
    x => { x.fleet.delete(7); }, x => { x.requirements.delete(91); }, x => { x.departures.delete('7:first'); },
    x => { x.datasetSha256='c'.repeat(64); }, x => { x.tariffSha256=''; },
    x => { x.request.tasks[0]!.type='pickup'; }, x => { x.request.dimension_count=3; },
    x => { x.request.vehicles[0]!.end_depot_id=1; }, x => { x.request.tasks[0]!.demand=[-100,1]; },
    x => { x.request.precedences=[{before:91,after:92}]; }, x => { x.layout.lockedVehicleIds=[7]; },
    x => { x.tariff.perKmDefault=NaN; }, x => { x.request.requests.push(x.request.requests[0]!); },
    x => { x.layout.requestIds=[91]; x.layout.routes=x.layout.routes.slice(0,1); },
    x => { x.layout.vehicleIds=[7]; },
  ];
  for (const change of changes) {
    const input=fixture(); change(input);
    assert.throws(()=>evaluateManualLayout(input),/manual evaluation:/);
  }
});

test('every placement reconciles independent distance, load, coverage and both tariff models', () => {
  // Enumerate unassigned / vehicle 7 / vehicle 42 for each delivery, with
  // separate-trip and merged-trip layouts. Expected values use matrix entries,
  // never the evaluator or production cost helpers.
  for (const model of ['per_vehicle','per_trip'] as const) for (let a=0;a<3;a++) for(let b=0;b<3;b++) for(const split of [false,true]) {
    const input=fixture(); input.tariff.model=model;
    input.layout.routes=[];input.layout.unassigned=[];
    for(const [index,placement] of [a,b].entries()) {
      const id=91+index;
      if(!placement){input.layout.unassigned.push(id);continue;}
      const vehicleId=placement===1?7:42,tripId=split?`split-${id}`:'merged';
      let route=input.layout.routes.find(r=>r.vehicleId===vehicleId&&r.tripId===tripId);
      if(!route){route={vehicleId,tripId,requestIds:[]};input.layout.routes.push(route);}
      route.requestIds.push(id);input.departures.set(`${vehicleId}:${tripId}`,0);
    }
    const out=evaluateManualLayout(input);
    let distance=0,tripCount=0,cost=0;
    const used=new Set<number>();
    for(const route of input.layout.routes){
      const locations=[0,...route.requestIds.map(id=>id-90),0];
      let km=0;for(let i=1;i<locations.length;i++)km+=input.request.travel.distances[locations[i-1]!*3+locations[i]!]!/1000;
      distance+=km;tripCount++;used.add(route.vehicleId);
      cost+=model==='per_trip'?500+10*km+50*route.requestIds.length:10*km;
    }
    if(model==='per_vehicle')cost+=1000*used.size;
    assert.deepEqual(out.stats,{totalOrders:2,servedOrders:Number(a>0)+Number(b>0),unassignedOrders:Number(!a)+Number(!b),vehiclesUsed:used.size,trips:tripCount,totalDistanceKm:distance});
    assert.equal(out.cost.total,cost);assert.equal(out.cost.fixed+out.cost.variable,cost);
    assert.equal(out.vehicles.reduce((sum,v)=>sum+v.cost,0),cost);
    assert.equal(out.vehicles.flatMap(v=>v.trips).reduce((sum,t)=>sum+t.cost,0),cost);
    for(const v of out.vehicles)for(const trip of v.trips){
      assert.equal(trip.loadKg,100*trip.stops.length);assert.equal(trip.loadPallets,trip.stops.length);
      assert.ok(trip.endSec>=trip.startSec);
    }
  }
});

test('unknown GVW does not clear access restriction and exact GVW limit is accepted', () => {
  const input=fixture(); input.requirements.set(91,{maxTonnage:12,requiresTailLift:false});
  assert.equal(evaluateManualLayout(input).validation.valid,true);
  input.fleet.get(7)!.grossTonnage=null;
  assert.ok(evaluateManualLayout(input).validation.violations.some(v=>v.type==='VEHICLE_SIZE'));
});

test('retained manual deassignment and mismatched vehicle are visible validation failures', () => {
  const input=fixture(); input.layout.decisions={'91':{kind:'unassigned'},'92':{kind:'vehicle',vehicleId:42}};
  const out=evaluateManualLayout(input);
  assert.equal(out.validation.violations.filter(v=>v.type==='ASSIGNMENT').length,2);
});

test('shift opening and explicit later departure anchors propagate deterministically', () => {
  const input=fixture(); input.request.vehicles[0]!.shift_early=1000;
  input.departures.set('7:second',2000);
  const trips=evaluateManualLayout(input).vehicles[0]!.trips;
  assert.deepEqual(trips.map(t=>t.startSec),[1000,2000]);
  input.request.requests[0]!.allowed_vehicles=[42];
  assert.ok(evaluateManualLayout(input).validation.violations.some(v=>v.type==='ASSIGNMENT' && v.requestId===91));
});

test('rounding cannot make the last trip cost negative', () => {
  const input=fixture();
  input.tariff.fixedPerVehicle=3; input.tariff.perKmDefault=0;
  for (let id=93;id<=95;id++) {
    input.layout.requestIds.push(id);
    input.request.requests.push({id,delivery_task_id:1});
    input.requirements.set(id,{maxTonnage:null,requiresTailLift:false});
    input.layout.routes.push({vehicleId:7,tripId:`trip-${id}`,requestIds:[id]});
    input.departures.set(`7:trip-${id}`,0);
  }
  const out=evaluateManualLayout(input);
  assert.equal(out.cost.total,3);
  assert.equal(out.vehicles[0]!.trips.reduce((sum,t)=>sum+t.cost,0),3);
  assert.ok(out.vehicles[0]!.trips.every(t=>t.cost>=0));
});

test('native limit conventions: omitted trips means one; explicit zero limits are unlimited', () => {
  const input=fixture(),vehicle=input.request.vehicles[0]!;
  vehicle.max_distance=0;vehicle.max_duration=0;
  assert.equal(evaluateManualLayout(input).validation.valid,true);
  delete vehicle.max_trips;
  const result=evaluateManualLayout(input);
  assert.equal(result.validation.valid,false);
  assert.deepEqual(result.validation.violations.map(v=>[v.type,v.actual,v.limit]),[['MAX_TRIPS',2,1]]);
  vehicle.max_trips=2;
  assert.equal(evaluateManualLayout(input).validation.valid,true);
  vehicle.max_trips=1.5;
  assert.throws(()=>evaluateManualLayout(input),/invalid trip limit/);
});
