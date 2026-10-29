import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {DestinationSummary,TransferAcknowledgement,TransferEnvelope} from '../integration-contract.js';

export interface Destination extends DestinationSummary {tenantId:string;url:string;tokenFile:string;sha256:string}
export interface TransferRequest {body:string;payloadSha256:string;idempotencyKey:string;envelope:TransferEnvelope}
export interface HandoffSender {
 send(destination:Destination,request:TransferRequest,signal:AbortSignal):Promise<TransferAcknowledgement>;
 lookup(destination:Destination,request:TransferRequest,signal:AbortSignal):Promise<TransferAcknowledgement|null>;
}
export class TransferFailure extends Error {constructor(message:string,readonly retryable:boolean){super(message);}}

export function parseDestinations(value:unknown,allowTestHttp=false):Destination[]{
 const root=value as {destinations?:unknown[]};
 if(!root||!Array.isArray(root.destinations)||root.destinations.length>100||Object.keys(root).some(k=>k!=='destinations'))throw new Error('Invalid handoff configuration.');
 const seen=new Set<string>();
 return root.destinations.map(raw=>{
  const d=raw as {id:string;tenantId:string;label:string;url:string;tokenFile:string;protocol:string};
  if(!d||Object.keys(d).some(k=>!['id','tenantId','label','url','tokenFile','protocol'].includes(k))||
   !/^[a-zA-Z0-9_-]{1,64}$/.test(d.id)||typeof d.tenantId!=='string'||!d.tenantId||d.tenantId.length>128||
   typeof d.label!=='string'||!d.label.trim()||d.label.length>120||d.protocol!=='cursus.handoff.v1'||
   typeof d.url!=='string'||typeof d.tokenFile!=='string'||!isAbsolute(d.tokenFile))throw new Error('Invalid handoff destination.');
  let url:URL;try{url=new URL(d.url);}catch{throw new Error('Invalid handoff destination URL.');}
  if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(allowTestHttp&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]','cursus-handoff-receiver'].includes(url.hostname)))
   throw new Error('Handoff destinations require HTTPS without embedded credentials or query parameters.');
  const key=`${d.tenantId}/${d.id}`;if(seen.has(key))throw new Error('Duplicate handoff destination.');seen.add(key);
  const sha256=createHash('sha256').update(JSON.stringify([d.tenantId,d.id,d.protocol,url.href])).digest('hex');
  return {...d,url:url.href,protocol:'cursus.handoff.v1',sha256};
 });
}

export function validateAcknowledgement(value:unknown,request:TransferRequest):TransferAcknowledgement{
 const a=value as TransferAcknowledgement;
 if(!a||typeof a!=='object'||Object.keys(a).some(k=>!['status','receiptId','idempotencyKey','payloadSha256','generation','planSha256','scenarioRevision'].includes(k))||
  !['accepted','rejected'].includes(a.status)||typeof a.receiptId!=='string'||!/^[a-zA-Z0-9_.:-]{1,200}$/.test(a.receiptId)||
  a.idempotencyKey!==request.idempotencyKey||a.payloadSha256!==request.payloadSha256||a.generation!==request.envelope.generation||
  a.planSha256!==request.envelope.planSha256||a.scenarioRevision!==request.envelope.scenarioRevision)
  throw new TransferFailure('Receiver acknowledgement did not match the exact instruction.',true);
 return {status:a.status,receiptId:a.receiptId,idempotencyKey:a.idempotencyKey,payloadSha256:a.payloadSha256,
  generation:a.generation,planSha256:a.planSha256,scenarioRevision:a.scenarioRevision};
}

export class HttpHandoffSender implements HandoffSender {
 private constructor(private credentials:Map<string,string>){}
 static async create(destinations:Destination[]):Promise<HttpHandoffSender>{
  const credentials=new Map<string,string>();
  for(const d of destinations){
   let secret:string;try{secret=(await readFile(d.tokenFile,'utf8')).trim();}catch{throw new Error('Handoff credential is unavailable.');}
   if(!secret||secret.length>4096||/[\r\n]/.test(secret))throw new Error('Invalid handoff credential.');
   credentials.set(`${d.tenantId}/${d.id}`,secret);
  }
  return new HttpHandoffSender(credentials);
 }
 async send(destination:Destination,request:TransferRequest,signal:AbortSignal):Promise<TransferAcknowledgement>{
  const result=await this.exchange(destination,request,signal,'POST');
  if(!result)throw new TransferFailure('Receiver returned no acknowledgement.',false);return result;
 }
 async lookup(destination:Destination,request:TransferRequest,signal:AbortSignal):Promise<TransferAcknowledgement|null>{
  return this.exchange(destination,request,signal,'GET');
 }
 private async exchange(destination:Destination,request:TransferRequest,signal:AbortSignal,method:'GET'|'POST'):Promise<TransferAcknowledgement|null>{
  const token=this.credentials.get(`${destination.tenantId}/${destination.id}`);
  if(!token)throw new TransferFailure('Handoff credential is unavailable.',false);
  let response:Response;
  try{response=await fetch(destination.url,{method,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),
   headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'idempotency-key':request.idempotencyKey,
    'x-cursus-payload-sha256':request.payloadSha256,'x-cursus-generation':String(request.envelope.generation),
    ...(method==='GET'?{}:request.envelope.previousReceiptId?{'if-match':`"${request.envelope.previousReceiptId}"`}:{'if-none-match':'*'})},body:method==='POST'?request.body:undefined});
  }catch{throw new TransferFailure('Receiver response is ambiguous; the same instruction key will be retained.',true);}
  if(method==='GET'&&response.status===404){await response.body?.cancel();return null;}
  let value:unknown;
  try{
   const reader=response.body?.getReader();if(!reader)throw new Error();const chunks:Uint8Array[]=[];let length=0;
   while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>65536){await reader.cancel();throw new Error();}chunks.push(part.value);}
   value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw new TransferFailure(`Receiver returned no valid acknowledgement (HTTP ${response.status}).`,response.status===408||response.status===429||response.status>=500||response.ok);}
  const acknowledgement=validateAcknowledgement(value,request);
  if(acknowledgement.status==='accepted'&&!response.ok)throw new TransferFailure('Receiver acceptance conflicted with its HTTP status.',true);
  return acknowledgement;
 }
}
