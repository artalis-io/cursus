// Public synthetic data only. This helper runs inside the production image,
// outside the application HTTP process; it never bypasses browser authentication.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { config } from '/app/server/dist/config.js';
import { StatefulStore } from '/app/server/dist/state/postgres.js';
import { ObjectStore } from '/app/server/dist/state/objects.js';
import { solveConvertedDataset } from '/app/server/dist/state/conversion.js';
import { manualSettings } from '/app/server/dist/state/manual-settings.js';
import {validateShipments} from '/app/server/dist/shipments.js';
import {enrichmentFromRecords} from '/app/server/dist/data/dataset.js';
const require = createRequire('/app/server/package.json');
const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
const url = (await readFile(config.databaseUrlFile, 'utf8')).trim();
assert.equal(new URL(url).hostname, 'postgres', 'fixture is restricted to the isolated Compose database');
assert.equal(config.authTenantId, 'acceptance');
assert.equal(config.r2Endpoint, 'http://s3-test:8333');
assert.equal(config.r2Bucket, 'cursus-acceptance');
const store = new StatefulStore(url);
const credentials = { accessKeyId: 'integration', secretAccessKey: 'integration' };
const objects = new ObjectStore(config.r2Bucket, { endpoint: config.r2Endpoint, ...credentials });

async function seed() {
  await store.migrate();
  assert.equal(Number((await store.pool.query('select count(*) from tenants')).rows[0].count), 0,
    'acceptance requires a fresh disposable database; never truncate existing state');
  await new S3Client({ endpoint: config.r2Endpoint, region: 'us-east-1', forcePathStyle: true, credentials })
    .send(new CreateBucketCommand({ Bucket: config.r2Bucket }));
  await store.ensureTenant('acceptance', 'Acceptance workspace');
  const request = {
    config: { max_time_seconds: 2, seed: 42, hard_capacity: true, hard_time_windows: true },
    dimension_count: 2, demand_sign_convention: 1,
    locations: Array.from({ length: 9 }, (_, i) => ({ x: 19 + i * .002, y: 47 + i * .001 })),
    depots: [{ location_id: 0, tw_early: 0, tw_late: 86400 }],
    vehicles: [10, 30, 50, 99].map(id => ({ id, ref: `ACCEPT-${id}`, capacity: [1000, 10],
      gross_weight_kg: id===99?0:id === 30 ? 12000 : 3500, has_tail_lift: id === 30,
      start_depot_id: 0, end_depot_id: 0, shift_early: 0, shift_late: 86400, max_trips: 1 })),
    tasks: Array.from({ length: 8 }, (_, i) => ({ id: i, ref: `PUBLIC-${i + 1}`, type: 'delivery',
      location_id: i + 1, tw_early: 0, tw_late: 86400, service_seconds: 60, demand: [100, 1] })),
    requests: Array.from({ length: 8 }, (_, i) => ({ id: 100 + i * 10, delivery_task_id: i,forbidden_vehicles:[99] })),
    travel: { location_count: 9,
      distances: Array.from({ length: 81 }, (_, k) => { const i = Math.floor(k / 9), j = k % 9; return i === j ? 0 : (1 + (i * 7 + j * 3) % 9) * 1000; }),
      durations: Array.from({ length: 81 }, (_, k) => { const i = Math.floor(k / 9), j = k % 9; return i === j ? 0 : (1 + (i * 7 + j * 3) % 9) * 60; }),
    },
  };
  // The second day intentionally has two deliveries with the same business
  // reference; only their immutable request IDs distinguish them.
  request.tasks[3].ref='PUBLIC-REPEAT';request.tasks[7].ref='PUBLIC-REPEAT';
  // Interleaved days retain sparse request IDs, reproducing the production
  // boundary that legacy browser tests missed. No private customers or files.
  const geo = { records: request.tasks.map((task, i) => ({ request_id:request.requests[i].id,order_no: task.ref,
    delivery_date: i % 4 === 3 ? '2026-05-07' : '2026-05-06', customer: `Public fixture ${i + 1}`,
    city: 'Budapest', lat: request.locations[i + 1].y, lon: request.locations[i + 1].x,
    ...(i === 0 ? { special_req: 'emelőhátfal 5,5 t' } : {}) })) };
  const requestObject = await objects.putImmutable('acceptance', Buffer.from(JSON.stringify(request)), 'application/json');
  const geoObject = await objects.putImmutable('acceptance', Buffer.from(JSON.stringify(geo)), 'application/json');
  const metadata=validateShipments({schemaVersion:1,datasetSha256:requestObject.sha256,
    shipments:request.requests.map((order,i)=>({id:`commercial-${order.id}`,reference:`Public order ${i+1}`,splitPolicy:'indivisible',
      lines:[{id:'line-1',productRef:`SKU-${i+1}`,quantity:10,unit:'case',grossWeightKg:100}]})),
    deliveries:request.requests.map((order,i)=>({id:`delivery-${order.id}`,requestId:order.id,reference:request.tasks[i].ref,locationId:i+1,
      date:i%4===3?'2026-05-07':'2026-05-06',shipmentId:`commercial-${order.id}`,allocations:[{lineId:'line-1',quantity:10}],
      planningWeightKg:100,palletEquivalent:1,weightBasis:'gross',detail:'line_items',loadUnits:[{id:'pallet',kind:'EUR pallet',quantity:1,stackable:false,grossWeightKg:100}]}))},request,requestObject.sha256);
  const shipmentObject=await objects.putImmutable('acceptance',Buffer.from(JSON.stringify(metadata)),'application/json');
  const manifest = { schemaVersion: 1, label: 'Public acceptance fixture', name: 'public-fixture.json', source: requestObject,
    artifacts: { request: requestObject, geocoded: geoObject,shipments:shipmentObject }, stats: { routable: 8 },
    days: [{ dayId: 'acceptance-day', date: '2026-05-06', isoDate: '2026-05-06', label: 'Public day one', orders: 6 },
      { dayId: 'acceptance-day-two', date: '2026-05-07', isoDate: '2026-05-07', label: 'Public day two', orders: 2 }] };
  for (const artifact of [requestObject, geoObject,shipmentObject]) await store.stageObject('acceptance', artifact);
  await store.createDatasetUpload('acceptance', 'acceptance-dataset', { source: requestObject });
  await store.enqueueJob('acceptance', 'dataset-admit', 'fixture-admission', {});
  const lease = await store.claimJob('dataset-admit', 'fixture', 120);
  await store.completeDatasetAdmission(lease, 'acceptance-dataset', manifest, [requestObject, geoObject,shipmentObject]);
  for (const day of manifest.days) {
    const scenario = { id: `${day.dayId}-base`, day: day.dayId, kind: 'base', revision: 0, parentId: null,
      label: day.label, removedVehicleIds: [], pins: [], forbids: [], sequences: [], vehicleOverrides: [], createdAt: new Date().toISOString() };
    if (day.dayId === 'acceptance-day') scenario.planningPolicy = {
      version: 1, id: 'acceptance-approved-policy', date: day.isoDate, datasetRequestSha256: requestObject.sha256,
      approvedAt: new Date().toISOString(), approvedBy: 'acceptance fixture',
      exceptions: [{ orderNo: 'PUBLIC-1', originalRequiresTailLift: true, requiresTailLift: false, reason: 'Public fixture unloading approval' }],
    };
    await store.createScenario('acceptance', scenario.id, scenario);
    const policy=manualSettings(JSON.parse(await readFile(process.env.CURSUS_MANUAL_SETTINGS_FILE,'utf8')));
    const plan = await solveConvertedDataset(objects, 'acceptance', manifest, scenario, 2, 'vehicles', AbortSignal.timeout(30000),false,policy);
    assert.equal(plan.stats.servedOrders, day.orders);
    assert.equal(plan.provenance.validation.valid, true, 'native baseline must preserve IDs and satisfy feasibility');
    plan.source = 'saved';
    await store.enqueueJob('acceptance', 'solve', `fixture/${day.dayId}`, { scenarioId: scenario.id });
    const solveLease = await store.claimJob('solve', 'fixture', 120);
    await store.completeSolve(solveLease, plan.id, scenario.id, 0, plan);
    // Known foreign IDs allow HTTP tests to prove isolation, including exports.
    if (day.dayId === 'acceptance-day') {
      await store.ensureTenant('foreign', 'Foreign fixture');
      await store.createScenario('foreign', 'foreign-scenario', { ...scenario, id: 'foreign-scenario' });
      await store.enqueueJob('foreign', 'solve', 'foreign-plan', {});
      const foreign = await store.claimJob('solve', 'fixture', 120);
      await store.completeSolve(foreign, 'foreign-plan', 'foreign-scenario', 0,
        { ...plan, id: 'foreign-plan', scenarioId: 'foreign-scenario' });
    }
  }
  return { seeded: true, orders: 8, days: 2, geographyVerified: false };
}
try {
  const action = process.argv[2];
  let result;
  if (action === 'seed') result = await seed();
  else if (action === 'link' || action === 'expire-link') {
    const { rows } = await store.pool.query("select payload from email_outbox where tenant_id='acceptance' order by created_at desc limit 1");
    const link = rows[0]?.payload.html.match(/href="([^"]+)"/)?.[1];
    assert.ok(link, 'login must queue a real transactional outbox intent');
    if (action === 'expire-link') {
      const hash = createHash('sha256').update(new URL(link).searchParams.get('token')).digest('hex');
      const expired = await store.pool.query("UPDATE magic_links SET expires_at=now()-interval '1 second' WHERE tenant_id='acceptance' AND token_hash=$1 AND consumed_at IS NULL", [hash]);
      assert.equal(expired.rowCount, 1, 'expire only the freshly requested isolated test link');
    }
    result = { link };
  } else if(action==='revised-input-bundle'){
    const row=await store.getDataset('acceptance','acceptance-dataset');assert.equal(row?.status,'admitted');
    const manifest=row.manifest,request=JSON.parse(new TextDecoder().decode(await objects.getVerified(manifest.artifacts.request)));
    const raw=JSON.parse(new TextDecoder().decode(await objects.getVerified(manifest.artifacts.geocoded))).records;
    const geocoded=raw.map(record=>{const info=enrichmentFromRecords([record]).get(String(record.order_no));assert.ok(info);
      return {...record,request_id:record.request_id+1000,requires_tail_lift:info.requiresTailLift,max_gross_weight_kg:info.maxTonnage===null?null:info.maxTonnage*1000};});
    request.requests=request.requests.map(order=>({...order,id:order.id+1000}));
    request.tasks.find(task=>task.id===3).demand[0]=150;
    result={schemaVersion:1,days:manifest.days.map(day=>({...day,dayId:day.dayId+'-revised'})),surgeRequest:request,geocoded};
  } else if (action === 'evidence') {
    const migrations = (await store.pool.query('select version from schema_migrations order by version')).rows.map(r => r.version);
    const mail = (await store.pool.query('select state,count(*)::int as count from email_outbox group by state')).rows;
    assert.ok(mail.every(r => r.state === 'pending'), 'acceptance must never send emails');
    result = { migrations, outbox: mail, native: {} };
    for (const [name, path] of Object.entries({ surge: config.surgeBin, matrix: config.matrixBuildBin, nexus: `${config.nexusDir}/nx_pipeline` }))
      result.native[name] = createHash('sha256').update(await readFile(path)).digest('hex');
  } else throw Error('expected seed, link, expire-link, or evidence');
  console.log(JSON.stringify(result));
} finally { await store.close(); }
