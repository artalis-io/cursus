import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/* HTTP-level tests of the Fastify app via app.inject() (no port bound). Exercises
 * the security middleware + error envelope + the pure-ish routes that don't need
 * a solver/geocode subprocess. Data-dependent (importing server.ts builds the
 * day baselines), so this lives in `test`, not `test:ci`.
 *
 * Env is set BEFORE importing server.ts so config captures it: a temp data dir,
 * a tiny rate-limit burst, a single allow-listed CORS origin, and no listen. */
let app: FastifyInstance;
let tmp: string;
let ipn = 0;
const freshIp = (): string => { ipn++; return `10.${(ipn >> 8) & 255}.0.${ipn & 255}`; };
interface InjResp { statusCode: number; headers: Record<string, string | string[] | undefined>; body: string; json<T = unknown>(): T }
function inj(opts: { method: string; url: string; headers?: Record<string, string>; payload?: unknown; ip?: string }): Promise<InjResp> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.payload && typeof opts.payload === 'object') headers['content-type'] = 'application/json';
  return app.inject({ remoteAddress: opts.ip ?? freshIp(), method: opts.method, url: opts.url, headers, payload: opts.payload } as never) as unknown as Promise<InjResp>;
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), `dispatch-http-${randomUUID().slice(0, 8)}-`));
  process.env.DISPATCH_NO_LISTEN = '1';
  process.env.DISPATCH_DATA_DIR = tmp;
  process.env.DISPATCH_RATE_BURST = '4';
  process.env.DISPATCH_RATE_RPS = '1';
  process.env.DISPATCH_CORS_ORIGINS = 'https://allowed.example';
  const mod = await import('./server.js');
  app = mod.app;
  await app.ready();
});
after(async () => { try { await app?.close(); } catch { /* ignore */ } if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('404 returns a JSON error envelope (no stack) + security headers', async () => {
  const r = await inj({ method: 'GET', url: '/api/plans/pln_nonexistent' });
  assert.equal(r.statusCode, 404);
  assert.deepEqual(r.json(), { error: 'plan not found' });
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.ok(r.headers['content-security-policy']);
});

test('CORS reflects only an allow-listed origin; preflight carries no ACAO for others', async () => {
  const ok = await inj({ method: 'GET', url: '/api/config', headers: { origin: 'https://allowed.example' } });
  assert.equal(ok.headers['access-control-allow-origin'], 'https://allowed.example');
  const bad = await inj({ method: 'GET', url: '/api/config', headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  const preflight = await inj({ method: 'OPTIONS', url: '/api/days', headers: { origin: 'https://evil.example' } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
});

test('rate limiter returns 429 past the per-IP burst', async () => {
  let saw429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await inj({ method: 'GET', url: '/api/config', ip: '10.222.0.1' }); // one IP, one bucket (burst=4)
    if (r.statusCode === 429) { saw429 = true; break; }
  }
  assert.ok(saw429, 'expected a 429 within 8 rapid requests from one IP');
});

test('health is exempt from the rate limit', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await inj({ method: 'GET', url: '/api/health', ip: '10.222.0.2' });
    assert.notEqual(r.statusCode, 429);
  }
});

test('GET /api/scenarios requires a day and lists the base for a known day', async () => {
  const noDay = await inj({ method: 'GET', url: '/api/scenarios' });
  assert.equal(noDay.statusCode, 400);
  const list = await inj({ method: 'GET', url: '/api/scenarios?day=day1' });
  assert.equal(list.statusCode, 200);
  assert.ok((list.json() as { kind: string }[]).some((s) => s.kind === 'base'));
});

test('rename rejects an empty label and 404s an unknown scenario', async () => {
  const empty = await inj({ method: 'POST', url: '/api/scenarios/day1-base/rename', payload: { label: '' } });
  assert.equal(empty.statusCode, 400);
  const nf = await inj({ method: 'POST', url: '/api/scenarios/scn_nope/rename', payload: { label: 'x' } });
  assert.equal(nf.statusCode, 404);
});

test('scenario import rejects a bad bundle and an unknown day', async () => {
  const bad = await inj({ method: 'POST', url: '/api/scenarios/import', payload: { nope: 1 } });
  assert.equal(bad.statusCode, 400);
  const unknownDay = await inj({ method: 'POST', url: '/api/scenarios/import', payload: { otto_scenario: 1, day: 'nope', edits: {} } });
  assert.equal(unknownDay.statusCode, 400);
});

test('DELETE a base scenario is rejected (400)', async () => {
  const r = await inj({ method: 'DELETE', url: '/api/scenarios/day1-base' });
  assert.equal(r.statusCode, 400);
});

test('outbound routes.csv serves CSV with the routes_fact header', async () => {
  const r = await inj({ method: 'GET', url: '/api/plans/day1-baseline/routes.csv' });
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-type'] ?? ''), /text\/csv/);
  assert.ok(r.body.split('\n')[0]!.startsWith('order_no,vehicle,sequence,date'));
});

test('handoff.json serves a structured dispatch plan', async () => {
  const r = await inj({ method: 'GET', url: '/api/plans/day1-baseline/handoff.json' });
  assert.equal(r.statusCode, 200);
  const h = r.json() as { otto_dispatch_plan: number; routes: unknown[] };
  assert.equal(h.otto_dispatch_plan, 1);
  assert.ok(Array.isArray(h.routes) && h.routes.length > 0);
});

test('evaluate recomputes a reordered trip without a re-solve', async () => {
  type Stop = { orderNo: string };
  type Trip = { index: number; stops: Stop[]; distanceKm: number };
  type Veh = { id: number; trips: Trip[] };
  const planR = await inj({ method: 'GET', url: '/api/plans/day1-baseline' });
  assert.equal(planR.statusCode, 200);
  const plan = planR.json() as { vehicles: Veh[] };
  // find a vehicle whose first trip has >= 2 stops (so a reorder is meaningful)
  const veh = plan.vehicles.find((v) => v.trips[0] && v.trips[0].stops.length >= 2);
  assert.ok(veh, 'expected a multi-stop trip in the baseline');
  const trip = veh!.trips[0]!;
  const orders = trip.stops.map((s) => s.orderNo);

  // same order reproduces the stop set; reversed order is accepted and recomputed
  const same = await inj({ method: 'POST', url: '/api/plans/day1-baseline/evaluate', payload: { vehicleId: veh!.id, tripIndex: trip.index, orderNos: orders } });
  assert.equal(same.statusCode, 200);
  const sameTrip = (same.json() as { trip: Trip }).trip;
  assert.equal(sameTrip.stops.length, orders.length);
  assert.deepEqual(sameTrip.stops.map((s) => s.orderNo), orders);

  const rev = await inj({ method: 'POST', url: '/api/plans/day1-baseline/evaluate', payload: { vehicleId: veh!.id, tripIndex: trip.index, orderNos: [...orders].reverse() } });
  assert.equal(rev.statusCode, 200);
  const revTrip = (rev.json() as { trip: Trip }).trip;
  assert.deepEqual(revTrip.stops.map((s) => s.orderNo), [...orders].reverse());
});

test('bulk edits apply several pins in one forked copy', async () => {
  const baseR = await inj({ method: 'POST', url: '/api/scenarios', payload: { day: 'day1' } });
  const base = baseR.json() as { id: string };
  const edits = [{ op: 'pin', orderNo: 'BULK-1', vehicleId: 0 }, { op: 'pin', orderNo: 'BULK-2', vehicleId: 0 }];
  const r = await inj({ method: 'POST', url: `/api/scenarios/${base.id}/edits`, payload: { edits } });
  assert.equal(r.statusCode, 201); // forked a copy from the base
  const sc = r.json() as { kind: string; pins: { orderNo: string; vehicleId: number }[] };
  assert.equal(sc.kind, 'copy');
  assert.ok(sc.pins.some((p) => p.orderNo === 'BULK-1') && sc.pins.some((p) => p.orderNo === 'BULK-2'));

  const empty = await inj({ method: 'POST', url: `/api/scenarios/${base.id}/edits`, payload: { edits: [] } });
  assert.equal(empty.statusCode, 400);
  const nf = await inj({ method: 'POST', url: '/api/scenarios/nope/edits', payload: { edits } });
  assert.equal(nf.statusCode, 404);
  const badEdit = await inj({ method: 'POST', url: `/api/scenarios/${base.id}/edits`, payload: { edits: [{ op: 'nonsense' }] } });
  assert.equal(badEdit.statusCode, 400);
});

test('evaluate validates its body (404 unknown plan, 400 bad order set)', async () => {
  const nf = await inj({ method: 'POST', url: '/api/plans/nope/evaluate', payload: { vehicleId: 1, orderNos: ['x'] } });
  assert.equal(nf.statusCode, 404);
  const noVeh = await inj({ method: 'POST', url: '/api/plans/day1-baseline/evaluate', payload: { orderNos: ['x'] } });
  assert.equal(noVeh.statusCode, 400);
  const planR = await inj({ method: 'GET', url: '/api/plans/day1-baseline' });
  const plan = planR.json() as { vehicles: { id: number }[] };
  // real vehicle but orders that are not a permutation of the trip -> 400
  const badOrders = await inj({ method: 'POST', url: '/api/plans/day1-baseline/evaluate', payload: { vehicleId: plan.vehicles[0]!.id, tripIndex: 0, orderNos: ['definitely-not-an-order'] } });
  assert.equal(badOrders.statusCode, 400);
});
