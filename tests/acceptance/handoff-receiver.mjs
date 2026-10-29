// Test-only receiver: durable deduplication and monotonic generation enforcement.
// Isolated Compose database; never used as a production integration adapter.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire('/app/server/package.json'),{Pool}=require('pg');
const connectionString=(await readFile('/acceptance-config/database-url','utf8')).trim();
if(new URL(connectionString).hostname!=='postgres')throw Error('Disposable database only');
const token=(await readFile('/acceptance-config/handoff-token','utf8')).trim(),pool=new Pool({connectionString});
await pool.query(`CREATE TABLE IF NOT EXISTS acceptance_receiver_heads(scope text PRIMARY KEY,generation bigint NOT NULL DEFAULT 0,receipt text);
 CREATE TABLE IF NOT EXISTS acceptance_receiver_receipts(key text PRIMARY KEY,sha256 text NOT NULL,ack jsonb NOT NULL)`);
const server=createServer(async(req,res)=>{
 let client;
 try{
  if(req.url==='/health'){res.end('ready');return;}
  if(req.url!=='/instructions'||req.headers.authorization!==`Bearer ${token}`){res.writeHead(403);res.end();return;}
  const key=String(req.headers['idempotency-key']??''),hash=String(req.headers['x-cursus-payload-sha256']??'');
  if(req.method==='GET'){
   const found=(await pool.query('SELECT sha256,ack FROM acceptance_receiver_receipts WHERE key=$1',[key])).rows[0];
   res.writeHead(found&&found.sha256===hash?200:404,{'content-type':'application/json'});res.end(JSON.stringify(found?.ack??{}));return;
  }
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>16*1024*1024)throw Error('Too large');}
  if(createHash('sha256').update(body).digest('hex')!==hash)throw Error('Hash mismatch');
  const instruction=JSON.parse(body);if(instruction.tenantId!=='acceptance'||instruction.protocol!=='cursus.handoff.v1')throw Error('Scope mismatch');
  client=await pool.connect();await client.query('BEGIN');const scope=JSON.stringify([instruction.tenantId,instruction.scenarioId,instruction.destinationId]);
  await client.query('INSERT INTO acceptance_receiver_heads(scope) VALUES($1) ON CONFLICT DO NOTHING',[scope]);
  const head=(await client.query('SELECT * FROM acceptance_receiver_heads WHERE scope=$1 FOR UPDATE',[scope])).rows[0];
  const prior=(await client.query('SELECT * FROM acceptance_receiver_receipts WHERE key=$1',[key])).rows[0];
  if(prior){if(prior.sha256!==hash)throw Error('Key reuse');await client.query('COMMIT');res.end(JSON.stringify(prior.ack));return;}
  const generation=Number(instruction.generation),accepted=Number.isSafeInteger(generation)&&generation>Number(head.generation)&&
   (head.receipt?req.headers['if-match']===`"${head.receipt}"`:req.headers['if-none-match']==='*');
  const receiptId=`test-receipt-${instruction.intentId}`,ack={status:accepted?'accepted':'rejected',receiptId,idempotencyKey:key,payloadSha256:hash,generation,planSha256:instruction.planSha256,scenarioRevision:instruction.scenarioRevision};
  await client.query('INSERT INTO acceptance_receiver_receipts(key,sha256,ack) VALUES($1,$2,$3)',[key,hash,ack]);
  if(accepted)await client.query('UPDATE acceptance_receiver_heads SET generation=$2,receipt=$3 WHERE scope=$1',[scope,generation,receiptId]);
  await client.query('COMMIT');res.end(JSON.stringify(ack));
 }catch{if(client)await client.query('ROLLBACK');res.writeHead(409);res.end('{}');}finally{client?.release();}
});
server.listen(8092,'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.closeAllConnections();server.close(()=>void pool.end());});
