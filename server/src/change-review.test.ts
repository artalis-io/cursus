import test from 'node:test';
import assert from 'node:assert/strict';
import {manualFixture} from './state/manual-fixture.js';
import {applyScenarioEdits} from './store.js';
import {undoInstructionEdit} from './change-review.js';
import {instructions,instructionKey} from './change-review-contract.js';
import {routePermission} from './route-permissions.js';
const sha='a'.repeat(64);
function fixture(){return {...manualFixture().scenario,deliveryDatasetSha256:sha,
 pins:[{orderNo:'REPEAT',requestId:91,vehicleId:7},{orderNo:'REPEAT',requestId:92,vehicleId:42}],
 forbids:[{orderNo:'REPEAT',requestId:91,vehicleId:42},{orderNo:'REPEAT',requestId:92,vehicleId:7}],
 removedVehicleIds:[99],vehicleOverrides:[{vehicleId:7,capacityKg:500}],sequences:[{vehicleId:7,orderNos:['REPEAT','REPEAT'],requestIds:[91,92],locked:true}],selectedPlanId:'saved-plan'};}
for(const op of ['pin','forbid','removeVehicle','setVehicleConstraint','setSequence'] as const)test(`Undo ${op} removes exactly the selected instruction`,()=>{
 const before=fixture(),snapshot=structuredClone(before),instruction=instructions(before).find(i=>i.op===op)!;
 const after=applyScenarioEdits(before,[undoInstructionEdit(before,{instruction,datasetSha256:sha})]);
 assert.deepEqual(before,snapshot);assert.equal(after.revision,before.revision+1);
 assert.deepEqual(instructions(after),instructions(before).filter(i=>instructionKey(i)!==instructionKey(instruction)));
 assert.equal(after.selectedPlanId,'saved-plan');assert.throws(()=>undoInstructionEdit(after,{instruction,datasetSha256:sha}),/changed/);
});
test('stable duplicate references retain the other delivery and every unrelated instruction',()=>{
 const before=fixture(),instruction=instructions(before).find(i=>i.op==='pin')!;
 const after=applyScenarioEdits(before,[undoInstructionEdit(before,{instruction,datasetSha256:sha})]);
 assert.deepEqual(after.pins,[{orderNo:'REPEAT',requestId:92,vehicleId:42}]);assert.deepEqual(after.forbids,before.forbids);assert.deepEqual(after.sequences,before.sequences);assert.deepEqual(after.vehicleOverrides,before.vehicleOverrides);
});
test('changed instruction, incomplete reference, duplicate stored rows, and foreign dataset fail closed',()=>{
 const s=fixture(),pin=s.pins[0]!;
 for(const instruction of [{op:'pin',...pin,vehicleId:42},{op:'pin',orderNo:pin.orderNo,vehicleId:7},{op:'clearOverrides'}])assert.throws(()=>undoInstructionEdit(s,{instruction,datasetSha256:sha}));
 for(const datasetSha256 of [undefined,'b'.repeat(64)])assert.throws(()=>undoInstructionEdit(s,{instruction:{op:'pin',...pin},datasetSha256}));
 s.pins.push({...pin});assert.throws(()=>undoInstructionEdit(s,{instruction:{op:'pin',...pin},datasetSha256:sha}),/changed/);
});
test('missing binding and immutable base cannot be undone',()=>{
 const s=fixture(),instruction={op:'pin',...s.pins[0]!};delete (s as {deliveryDatasetSha256?:string}).deliveryDatasetSha256;
 assert.throws(()=>undoInstructionEdit(s,{instruction,datasetSha256:sha}),/identity/);assert.throws(()=>undoInstructionEdit({...s,kind:'base'},{instruction,datasetSha256:sha}),/immutable/);
});
test('Undo requires scenario.edit',()=>assert.equal(routePermission('POST','/api/scenarios/:id/undo-instruction'),'scenario.edit'));

test('Undo preserves retained manual decisions and selected-plan identity',()=>{
 const s={...fixture(),manualPlanId:'manual-saved',manualDecisions:{datasetSha256:sha,decisions:{'91':{kind:'vehicle' as const,vehicleId:7}},unavailableVehicleIds:[99],origins:{'91':'manual' as const},history:[]}};
 const instruction=instructions(s).find(i=>i.op==='removeVehicle')!;
 const after=applyScenarioEdits(s,[undoInstructionEdit(s,{instruction})]);
 assert.deepEqual(after.manualDecisions,s.manualDecisions);assert.equal(after.manualPlanId,s.manualPlanId);assert.equal(after.selectedPlanId,s.selectedPlanId);
});

for(const op of ['pin','setVehicleConstraint','setSequence'] as const)test(`conflicting ${op} rows cannot broaden the inverse`,()=>{
 const s=fixture(),instruction=instructions(s).find(i=>i.op===op)!;
 if(op==='pin')s.pins.push({...s.pins[0]!,vehicleId:999});
 if(op==='setVehicleConstraint')s.vehicleOverrides.push({vehicleId:7,capacityKg:999});
 if(op==='setSequence')s.sequences.push({vehicleId:7,orderNos:['OTHER','REPEAT'],requestIds:[93,91],locked:false});
 const original=structuredClone(s);assert.throws(()=>undoInstructionEdit(s,{instruction,datasetSha256:sha}),/conflicting/);assert.deepEqual(s,original);
});

test('Undo one forbid keeps another vehicle prohibition for the same delivery',()=>{
 const s=fixture();s.forbids.push({orderNo:'REPEAT',requestId:91,vehicleId:99});
 const after=applyScenarioEdits(s,[undoInstructionEdit(s,{instruction:{op:'forbid',...s.forbids[0]!},datasetSha256:sha})]);
 assert.deepEqual(after.forbids,s.forbids.slice(1));assert.deepEqual(after.pins,s.pins);
});
