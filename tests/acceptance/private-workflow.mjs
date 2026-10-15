// Optional external customer acceptance. Never prints records or raw errors.
import assert from 'node:assert/strict';
import { readFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { config } from '/app/server/dist/config.js';
import { StatefulStore, StaleFenceError } from '/app/server/dist/state/postgres.js';
import { ObjectStore } from '/app/server/dist/state/objects.js';
import { executeDatasetConversion, solveConvertedDataset } from '/app/server/dist/state/conversion.js';
import { createStatefulApi } from '/app/server/dist/state/api.js';

const store = new StatefulStore((await readFile(config.databaseUrlFile, 'utf8')).trim());
const peer = new StatefulStore((await readFile(config.databaseUrlFile, 'utf8')).trim());
let apiA, apiB;
let stage = 'preflight';
let quality;
try {
  assert.equal(config.r2Endpoint, 'http://s3-test:8333');
  assert.equal(config.r2Bucket, 'cursus-acceptance');
  assert.equal(new URL((await readFile(config.databaseUrlFile, 'utf8')).trim()).hostname, 'postgres');
  const settings = JSON.parse(await readFile('/private/config.json', 'utf8'));
  assert.ok(settings.minimumServedFraction > 0 && settings.minimumServedFraction <= 1);
  await cp('/private/geocode-input', config.geocodeCacheDir, { recursive: true });
  const tenant = 'acceptance-private';
  await store.ensureTenant(tenant, 'Private acceptance');
  const objects = new ObjectStore(config.r2Bucket, { endpoint: config.r2Endpoint, accessKeyId: 'integration', secretAccessKey: 'integration' });
  const source = await objects.putImmutable(tenant, await readFile('/private/orders.csv'), 'text/csv');
  await store.stageObject(tenant, source);
  await store.createDatasetUpload(tenant, 'private-dataset', { source });
  await store.enqueueJob(tenant, 'dataset-admit', 'private-conversion', { datasetId: 'private-dataset', source,
    sourceName: settings.sourceName ?? 'orders.csv', mapping: settings.mapping, label: 'External acceptance' });
  const stale = await store.claimJob('dataset-admit', 'private-old', 120);
  const started = Date.now();
  stage = 'native-conversion';
  const converted = await executeDatasetConversion(stale, objects, AbortSignal.timeout(1200000));
  const conversionSec = (Date.now() - started) / 1000;
  // Deterministically simulate ownership loss after upload and before admission.
  await store.pool.query("update jobs set lease_expires_at=now()-interval '1 second' where tenant_id=$1 and id=$2", [tenant, stale.id]);
  stage = 'fenced-admission';
  const current = await peer.claimJob('dataset-admit', 'private-takeover', 120);
  await assert.rejects(() => store.completeDatasetAdmission(stale, converted.datasetId, converted.manifest, converted.artifacts), StaleFenceError);
  await peer.completeDatasetAdmission(current, converted.datasetId, converted.manifest, converted.artifacts);
  for (const object of converted.artifacts) await objects.getVerified(object);
  const day = converted.manifest.days[0];
  const scenario = { id: 'private-scenario', day: day.dayId, kind: 'copy', parentId: null, revision: 1,
    label: 'Private acceptance', removedVehicleIds: [], pins: [], forbids: [], sequences: [], vehicleOverrides: [], createdAt: new Date().toISOString() };
  await store.createScenario(tenant, scenario.id, scenario);
  await store.enqueueJob(tenant, 'solve', 'private-solve', { scenario });
  const solver = await store.claimJob('solve', 'private-native', 120);
  const solveStarted = Date.now();
  stage = 'native-solve';
  const plan = await solveConvertedDataset(objects, tenant, converted.manifest, scenario, settings.solveSeconds ?? 30, 'vehicles', AbortSignal.timeout(120000));
  stage = 'result-quality';
  quality = { served: plan.stats.servedOrders, total: plan.stats.totalOrders, valid: plan.provenance.validation.valid };
  assert.equal(plan.provenance.validation.valid, true);
  assert.ok(plan.stats.servedOrders / plan.stats.totalOrders >= settings.minimumServedFraction);
  assert.equal(plan.stats.totalOrders, plan.stats.servedOrders + plan.unassigned.length);
  assert.ok(plan.vehicles.every(v => !v.ref.startsWith('veh-')));
  await store.completeSolve(solver, plan.id, scenario.id, scenario.revision, plan);
  stage = 'cross-instance-api';
  apiA = await createStatefulApi({ store, objects, tenantId: tenant, tenantName: 'Private acceptance' });
  apiB = await createStatefulApi({ store: peer, objects, tenantId: tenant, tenantName: 'Private acceptance' });
  const read = await apiB.inject({ method: 'GET', url: `/api/plans/${plan.id}` });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().stats.servedOrders, plan.stats.servedOrders);
  const exported = await apiA.inject({ method: 'GET', url: `/api/plans/${plan.id}/handoff.json` });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.json().summary.totalOrders, plan.stats.totalOrders);
  console.log(JSON.stringify({ status: 'passed', sourceSha256: source.sha256,
    conversionFingerprint: converted.fingerprint, conversionSec, solveSec: (Date.now() - solveStarted) / 1000,
    served: plan.stats.servedOrders, total: plan.stats.totalOrders, minimumServedFraction: settings.minimumServedFraction,
    staleAdmissionRejected: true, artifactCount: converted.artifacts.length,
    artifactManifestSha256: createHash('sha256').update(JSON.stringify(converted.artifacts.map(a => a.sha256))).digest('hex') }));
} catch {
  console.error(`External dataset acceptance failed at ${stage}; private errors and records are suppressed.`);
  console.log(JSON.stringify({ status: 'failed', stage, ...(quality ? { quality } : {}) }));
  process.exitCode = 1;
} finally { await apiA?.close(); await apiB?.close(); await store.close(); await peer.close(); }
