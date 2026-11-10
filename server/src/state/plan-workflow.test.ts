import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Plan } from '../types.js';
import { approvalBlockers, planDigest } from './plan-workflow.js';

export function validPlan(): Plan {
  return { id: 'review-plan', scenarioId: 'review-scenario', scenarioRevision: 1,
    day: '2026-05-06', createdAt: '2026-05-06T00:00:00.000Z', source: 'live', objective: 'distance', cost: null,
    depot: { name: 'Test depot', lon: 19, lat: 47 },
    provenance: { inputSha256: 'a'.repeat(64), solverConfig: {}, termination: 'OK', validation: { valid: true, violations: [] } },
    stats: { servedOrders: 1, totalOrders: 1, deliveryStops: 1, vehiclesUsed: 1, trips: 1, totalDistanceKm: 10, solveElapsedSeconds: 1 }, unassigned: [],
    vehicles: [{ id: 1, ref: 'TEST-1', color: '#123456', vehicleClass: null, isSubcontractor: false,
      distanceKm: 10, tripCount: 1, finishTimeSec: 300, capacityKg: 1000, capacityPallets: 10, tonnage: 12, hasTailLift: true,
      trips: [{ index: 0, startSec: 0, endSec: 300, distanceKm: 10, reloadSecAfter: 0, loadKg: 100, loadPallets: 1, stops: [{ orderNo: 'ORDER', maxTonnage: 12, requiresTailLift: true,
        seq: 1, lon: 19.1, lat: 47.1, weightKg: 100, pallets: 1, serviceMin: 1, lateBySec: 0, departureSec: 160,
        arrivalSec: 90, serviceStartSec: 100, twStartSec: 100, twEndSec: 200 }] }] }],
  } as unknown as Plan;
}
test('approval hashes are independent of JSON object key order and include all immutable plan bytes', () => {
  assert.equal(planDigest({ b: 2, a: { d: 4, c: 3 } }), planDigest({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(planDigest(validPlan()), planDigest({ ...validPlan(), scenarioRevision: 2 }));
});
test('approval fails closed on stale, incomplete and missing evidence and hard constraint violations', () => {
  assert.deepEqual(approvalBlockers(validPlan(), 1), []);
  assert.ok(approvalBlockers(validPlan(), 2).length);
  for (const mutate of [
    (p: Plan) => { p.stats.servedOrders = 0; },
    (p: Plan) => { p.vehicles = []; },
    (p: Plan) => { p.provenance.validation.valid = false; },
    (p: Plan) => { p.provenance.validation.violations = [{ type: 'TAIL_LIFT', soft: true }]; },
    (p: Plan) => { p.provenance.inputSha256 = ''; },
    (p: Plan) => { p.vehicles[0]!.tonnage = 24; },
    (p: Plan) => { p.vehicles[0]!.hasTailLift = false; },
    (p: Plan) => { p.vehicles[0]!.trips[0]!.loadKg = 2000; },
    (p: Plan) => { p.vehicles[0]!.trips[0]!.stops[0]!.arrivalSec = 201.1; },
    (p: Plan) => { p.vehicles[0]!.trips[0]!.stops[0]!.maxTonnage = undefined as unknown as null; },
  ]) { const p = validPlan(); mutate(p); assert.ok(approvalBlockers(p, 1).length); }
});

test('legacy catalogue evidence never infers approval from a validated plan',async()=>{
 const {legacyLibraryPlan}=await import('../library.js');const p=validPlan();const item=legacyLibraryPlan(p,undefined,p.id);
 assert.equal(item.identity.approval,'unknown');assert.equal(item.identity.freshness,'unknown');assert.equal(item.identity.planSha256,null);
});

test('structured approval reasons preserve legacy gates and identify exact delivery/trip targets',async()=>{
 const {approvalIssues}=await import('./plan-workflow.js');
 const p=validPlan(),v=p.vehicles[0]!,trip=v.trips[0]!,stop=trip.stops[0]!;
 stop.requestId=7;v.tonnage=24;v.hasTailLift=false;trip.loadKg=2000;stop.arrivalSec=300;
 const issues=approvalIssues(p,2);
 assert.deepEqual(approvalBlockers(p,2),['Plan does not match the current scenario revision.','Capacity evidence is missing or violated.','GVW evidence is missing or violated.','Tail-lift evidence is missing or violated.','Time-window evidence is missing or violated.']);
 for(const code of ['gvw','tail_lift','time_window'])assert.deepEqual(issues.find(i=>i.code===code)?.target,{kind:'stop',vehicleId:1,tripIndex:0,seq:1,orderNo:'ORDER',requestId:7});
 assert.deepEqual(issues.find(i=>i.code==='capacity')?.target,{kind:'trip',vehicleId:1,tripIndex:0});
 assert.deepEqual(issues.find(i=>i.code==='revision_changed')?.target,{kind:'section',section:'changes'});
 // Equal labels remain separate evidence, never coalesced into one delivery.
 trip.stops.push({...stop,requestId:8,seq:2});
 assert.deepEqual(approvalIssues(p,1).filter(i=>i.code==='gvw').map(i=>i.target.kind==='stop'?i.target.requestId:null),[7,8]);
});

test('structured missing/failed evidence remains conservative without relaxing approval',async()=>{
 const {approvalIssues}=await import('./plan-workflow.js');const p=validPlan();
 p.provenance.inputSha256='';p.provenance.validation.valid=false;p.stats.servedOrders=0;
 assert.deepEqual(approvalIssues(p,1).map(i=>i.code),['validation_failed','coverage_incomplete','dataset_identity_missing']);
 const scenario={sequences:[{vehicleId:1,orderNos:['wrong'],locked:true}]} as import('../store.js').Scenario;
 assert.ok(approvalIssues(validPlan(),1,scenario).some(i=>i.code==='locked_route'));
 p.physicalLoading={mode:'hard'} as Plan['physicalLoading'];
 assert.ok(approvalIssues(p,1).some(i=>i.code==='physical_loading'));
});

// Independent boundary fixtures retain the existing checker’s tolerances.
test('approval explanation preserves early waiting and existing capacity/time tolerances',()=>{
 const early=validPlan();early.vehicles[0]!.trips[0]!.stops[0]!.arrivalSec=0;
 assert.deepEqual(approvalBlockers(early,1),[],'early arrival with service at opening is allowed');
 const edge=validPlan(),trip=edge.vehicles[0]!.trips[0]!,stop=trip.stops[0]!;
 trip.loadKg=1001;trip.loadPallets=10+1e-6;stop.arrivalSec=200;stop.serviceStartSec=201;
 assert.deepEqual(approvalBlockers(edge,1),[]);
 const weight=structuredClone(edge);weight.vehicles[0]!.trips[0]!.loadKg=1001.01;
 assert.deepEqual(approvalBlockers(weight,1),['Capacity evidence is missing or violated.']);
 const late=structuredClone(edge);late.vehicles[0]!.trips[0]!.stops[0]!.serviceStartSec=201.01;
 assert.deepEqual(approvalBlockers(late,1),['Time-window evidence is missing or violated.']);
});
