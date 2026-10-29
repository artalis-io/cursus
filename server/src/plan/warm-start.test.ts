import test from 'node:test';import assert from 'node:assert/strict';
import {warmStart} from './warm-start.js';import {manualFixture} from '../state/manual-fixture.js';
test('warm starts use the current independently feasible layout without freezing or rewriting it',()=>{
 const f=manualFixture(),request=structuredClone(f.context.day.request),before=structuredClone(f.parent);
 assert.equal(warmStart(request,f.parent,f.scenario,f.context),true);
 assert.deepEqual((request as unknown as {initial_routes:unknown}).initial_routes,[{vehicle_id:7,request_ids:[91,92]}]);
 assert.deepEqual(f.parent,before);
 assert.equal(warmStart(request,f.parent,{...f.scenario,revision:2},f.context),false);
 const impossible=structuredClone(f.parent);impossible.vehicles[0]!.trips[0]!.stops[0]!.requestId=999;
 assert.equal(warmStart(request,impossible,f.scenario,f.context),false);
});

test('warm-start hints fail closed on changed dataset, equipment or unavailable vehicles',()=>{
 for(const change of [
  (f:ReturnType<typeof manualFixture>)=>{f.context.day.datasetRequestSha256='b'.repeat(64);},
  (f:ReturnType<typeof manualFixture>)=>{f.context.vehicleInfo.clear();},
 ]){
  const f=manualFixture();change(f);
  assert.equal(warmStart(structuredClone(f.context.day.request),f.parent,f.scenario,f.context),false);
 }
 const f=manualFixture(),request=structuredClone(f.context.day.request);request.vehicles=[];
 assert.equal(warmStart(request,f.parent,f.scenario,f.context),false);
});
