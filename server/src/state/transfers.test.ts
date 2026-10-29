import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDestinations,validateAcknowledgement} from './handoff-sender.js';
import {parseTransferCommand} from './transfers.js';
const destination={id:'warehouse',tenantId:'tenant',label:'Warehouse',url:'https://receiver.example.test/instructions',tokenFile:'/run/secrets/receiver',protocol:'cursus.handoff.v1'};
test('handoff configuration is fixed, tenant-bound, HTTPS-only and rejects credential URLs and duplicate destinations',()=>{
 const parsed=parseDestinations({destinations:[destination]});assert.equal(parsed.length,1);assert.equal(parsed[0]!.sha256.length,64);
 for(const url of ['http://receiver.example.test','https://user:password@receiver.example.test','https://receiver.example.test/?token=secret','https://receiver.example.test/#secret'])
  assert.throws(()=>parseDestinations({destinations:[{...destination,url}]}));
 assert.throws(()=>parseDestinations({destinations:[destination,destination]}),/Duplicate/);
 assert.throws(()=>parseDestinations({destinations:[{...destination,tokenFile:'relative'}]}));
 assert.throws(()=>parseDestinations({destinations:[{...destination,url:'http://localhost:80'}]}));
 assert.equal(parseDestinations({destinations:[{...destination,url:'http://localhost:80'}]},true).length,1);
 assert.notEqual(parseDestinations({destinations:[{...destination,url:destination.url+'/new'}]})[0]!.sha256,parsed[0]!.sha256);
 assert.equal(parseDestinations({destinations:[{...destination,tokenFile:'/rotated/secret'}]})[0]!.sha256,parsed[0]!.sha256);
});
test('handoff rejects permissive command shapes and acknowledgements for another instruction or plan',()=>{
 const command={operationId:'public-operation',destinationId:'warehouse',version:0,operation:'publish',reason:'Dispatch approved plan',approvalVersion:2};
 assert.equal(parseTransferCommand(command).version,0);
 for(const bad of [{...command,url:'https://attacker.test'},{...command,version:-1},{...command,approvalVersion:0},{...command,operation:'delete'},{...command,reason:''}])assert.throws(()=>parseTransferCommand(bad));
 const request={body:'{}',payloadSha256:'a'.repeat(64),idempotencyKey:'public-key',envelope:{generation:1,planSha256:'b'.repeat(64),scenarioRevision:3}} as Parameters<typeof validateAcknowledgement>[1];
 const ack={status:'accepted',receiptId:'public-receipt',idempotencyKey:request.idempotencyKey,payloadSha256:request.payloadSha256,generation:1,planSha256:'b'.repeat(64),scenarioRevision:3};
 assert.equal(validateAcknowledgement(ack,request).status,'accepted');
 for(const key of ['idempotencyKey','payloadSha256','generation','planSha256','scenarioRevision'])assert.throws(()=>validateAcknowledgement({...ack,[key]:'wrong'},request));
 assert.throws(()=>validateAcknowledgement({...ack,secret:'never expose'},request));
});
