import fastifyStatic from '@fastify/static';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import { StatefulStore, type Lease } from './state/postgres.js';
import { ObjectStore } from './state/objects.js';
import { StatefulAuthService } from './state/auth.js';
import { createStatefulApi } from './state/api.js';
import { workOneSolve, type SolveOutput } from './state/worker.js';
import { solveConvertedDataset, workOneDatasetAdmission } from './state/conversion.js';
import { deliverOne, ResendSender } from './state/outbox.js';
import type { Scenario } from './store.js';

const required = (name: string, value: string): string => {
  if (!value) throw new Error(`${name} is required in stateful mode`);
  return value;
};
const secret = async (name: string, path: string): Promise<string> => {
  const value = (await readFile(required(name, path), 'utf8')).trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
};
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const databaseUrl = config.databaseUrlFile
  ? await secret('CURSUS_DATABASE_URL_FILE', config.databaseUrlFile)
  : required('CURSUS_DATABASE_URL', config.databaseUrl);
const accessKeyId = await secret('CURSUS_R2_ACCESS_KEY_ID_FILE', config.r2AccessKeyIdFile);
const secretAccessKey = await secret('CURSUS_R2_SECRET_ACCESS_KEY_FILE', config.r2SecretAccessKeyFile);
const store = new StatefulStore(databaseUrl);
const objects = new ObjectStore(required('CURSUS_R2_BUCKET', config.r2Bucket), {
  endpoint: required('CURSUS_R2_ENDPOINT', config.r2Endpoint), accessKeyId, secretAccessKey,
});
await store.migrate();
await objects.ready();

const auth = config.authRequired ? new StatefulAuthService(store, {
  allowedEmailsFile: required('CURSUS_AUTH_ALLOWED_EMAILS_FILE', config.authAllowedEmailsFile),
  publicOrigin: config.authPublicOrigin, from: config.authFrom,
  tenantId: config.authTenantId, tenantName: config.authTenantName,
  secureCookies: config.authPublicOrigin.startsWith('https://'),
}) : undefined;
const app = await createStatefulApi({ store, objects, auth, tenantId: config.authTenantId,
  tenantName: config.authTenantName, publicOrigin: config.authPublicOrigin, maxUploadBytes: config.maxUploadMB * 1024 * 1024 });
await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
app.setNotFoundHandler((req, reply) => req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/health/')
  ? reply.sendFile('index.html') : reply.code(404).send({ error: 'not found' }));

let stopping = false;
const workerId = `${config.statefulWorkerId}-${hostname()}-${process.pid}`;
async function solve(lease: Lease, signal: AbortSignal): Promise<SolveOutput> {
  const payload = lease.payload as { scenario?: Scenario; budgetSec?: number; objective?: 'vehicles' | 'distance'; fullBudget?: boolean };
  if (!payload.scenario) throw new Error('solve job has no scenario snapshot');
  const datasets = await store.listDatasets(lease.tenantId, true);
  const wantedSha = payload.scenario.manualDecisions?.datasetSha256 ?? payload.scenario.planningPolicy?.datasetRequestSha256;
  if (payload.scenario.manualDecisions && payload.scenario.planningPolicy && wantedSha !== payload.scenario.planningPolicy.datasetRequestSha256)
    throw new Error('manual decisions and policy reference different datasets');
  const matches = datasets.filter((item) => ((item.manifest as { days?: { dayId: string }[] })?.days ?? [])
    .some((day) => day.dayId === payload.scenario!.day) && (!wantedSha ||
      (item.manifest as { artifacts?: { request?: { sha256?: string } } }).artifacts?.request?.sha256 === wantedSha));
  if (payload.scenario.manualDecisions && matches.length !== 1) throw new Error('manual replanning requires exactly one pinned admitted dataset');
  const dataset = matches[0];
  if (!dataset) throw new Error(`no admitted dataset contains day ${payload.scenario.day}`);
  const plan = await solveConvertedDataset(objects, lease.tenantId, dataset.manifest as never, payload.scenario,
    Math.max(1, payload.budgetSec ?? config.solveTimeSeconds), payload.objective ?? 'vehicles', signal, payload.fullBudget ?? false);
  return { planId: plan.id, scenarioId: payload.scenario.id, scenarioRevision: payload.scenario.revision, plan };
}

async function loop(name: string, work: () => Promise<boolean>): Promise<void> {
  while (!stopping) {
    try { if (!(await work())) await delay(config.statefulPollMs); }
    catch (error) { app.log.error({ error, worker: name }, 'stateful worker iteration failed'); await delay(config.statefulPollMs); }
  }
}
const workers = [
  loop('solve', () => workOneSolve(store, solve, `${workerId}-solve`, config.statefulLeaseSec)),
  loop('conversion', () => workOneDatasetAdmission(store, objects, `${workerId}-conversion`, config.statefulLeaseSec)),
];
if (config.resendApiKeyFile) {
  const sender = new ResendSender(await secret('RESEND_API_KEY_FILE', config.resendApiKeyFile));
  workers.push(loop('email', () => deliverOne(store, sender, `${workerId}-email`)));
}

const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await app.close();
  await Promise.allSettled(workers);
  await store.close();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

try { await app.listen({ host: config.host, port: config.port }); }
catch (error) { stopping = true; await Promise.allSettled(workers); await store.close(); throw error; }
