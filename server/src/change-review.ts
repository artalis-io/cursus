import {instructions,instructionKey,type UndoInstruction} from './change-review-contract.js';
import {validateScenarioEdit,type Scenario,type ScenarioEdit} from './store.js';

/** Called under the scenario write lock. Never rebase an Undo onto newer state. */
export function undoInstructionEdit(s:Scenario,body:unknown):ScenarioEdit {
  if(s.kind==='base')throw new Error('An immutable base has no editable instructions.');
  if(!body||typeof body!=='object'||!('instruction' in body))throw new Error('instruction required');
  const request=body as UndoInstruction;
  const i=request.instruction;
  const invalid=validateScenarioEdit({...i,datasetSha256:request.datasetSha256});
  if(invalid)throw new Error(invalid);
  const matches=instructions(s).filter(row=>instructionKey(row)===instructionKey(i));
  if(matches.length!==1)throw new Error('This instruction changed. Reload before undoing it.');
  // The inverse must target exactly one row, including malformed legacy state
  // with conflicting (rather than byte-identical) rows for the same target.
  const sameDelivery=(row:{orderNo:string;requestId?:number})=>('orderNo' in i)&&row.orderNo===i.orderNo&&row.requestId===i.requestId;
  const targets=i.op==='pin'?s.pins.filter(sameDelivery).length
    :i.op==='forbid'?s.forbids.filter(row=>sameDelivery(row)&&row.vehicleId===i.vehicleId).length
    :i.op==='setVehicleConstraint'?s.vehicleOverrides.filter(row=>row.vehicleId===i.vehicleId).length
    :i.op==='setSequence'?s.sequences.filter(row=>row.vehicleId===i.vehicleId).length
    :s.removedVehicleIds.filter(id=>id===i.vehicleId).length;
  if(targets!==1)throw new Error('This instruction has conflicting targets. Reload and repair the scenario before undoing it.');
  const stable=('requestId' in i&&i.requestId!==undefined)||('requestIds' in i&&i.requestIds!==undefined);
  if(stable&&(!s.deliveryDatasetSha256||request.datasetSha256!==s.deliveryDatasetSha256))throw new Error('Delivery dataset identity changed. Reload before undoing it.');
  switch(i.op){
    case 'removeVehicle':return {op:'restoreVehicle',vehicleId:i.vehicleId};
    case 'pin':return {op:'unpin',orderNo:i.orderNo,...(i.requestId===undefined?{}:{requestId:i.requestId,datasetSha256:request.datasetSha256})};
    case 'forbid':return {op:'unforbid',orderNo:i.orderNo,vehicleId:i.vehicleId,...(i.requestId===undefined?{}:{requestId:i.requestId,datasetSha256:request.datasetSha256})};
    case 'setVehicleConstraint':return {op:'clearVehicleConstraint',vehicleId:i.vehicleId};
    case 'setSequence':return {op:'clearSequence',vehicleId:i.vehicleId};
    default:throw new Error('Unsupported instruction');
  }
}
