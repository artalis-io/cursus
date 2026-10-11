import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSchema, missingRequired, parseReconcile, parseSemantic, extFromName } from './onboard.js';
import { suggestMapping } from './catalog.js';

test('extFromName: recognizes csv and xlsx, rejects others', () => {
  assert.equal(extFromName('orders.csv'), 'csv');
  assert.equal(extFromName('Orders.CSV'), 'csv');
  assert.equal(extFromName('book.xlsx'), 'xlsx');
  assert.equal(extFromName('BOOK.XLSX'), 'xlsx');
  assert.equal(extFromName('data.xls'), null);   // legacy binary xls not supported
  assert.equal(extFromName('data.txt'), null);
  assert.equal(extFromName(undefined), null);
});

test('buildSchema: generates a valid nx_schema from a column mapping', () => {
  const s = buildSchema('orders', { order_no: 0, customer: 4, city: 6, weight_kg: 11, pallets: 12 }) as {
    nx_schema: number; columns: { source: number; target: string; type: string; required?: boolean }[];
  };
  assert.equal(s.nx_schema, 2);
  const byTarget = new Map(s.columns.map((c) => [c.target, c]));
  assert.equal(byTarget.get('order_no')!.source, 0);
  assert.equal(byTarget.get('order_no')!.required, true);   // required field flagged
  assert.equal(byTarget.get('weight_kg')!.type, 'double');
  assert.equal(byTarget.get('city')!.type, 'string');
  // 5 mapped + the derived address_geocode (city is mapped so the merge fires)
  assert.equal(byTarget.size, 6);
  assert.ok(byTarget.has('address_geocode'));
});

test('buildSchema: orders derive an address_geocode merge at the raw width', () => {
  const s = buildSchema('orders', { order_no: 0, customer: 4, city: 6, zip: 5, street: 7 }, 18) as {
    multi_transforms?: { type: string; sources: number[]; template: string; target: string }[];
    columns: { source: number; target: string }[];
  };
  assert.ok(s.multi_transforms, 'has multi_transforms');
  const mt = s.multi_transforms![0]!;
  assert.equal(mt.type, 'merge');
  assert.equal(mt.target, 'address_geocode');
  assert.deepEqual(mt.sources, [7, 5, 6]); // street, zip, city order
  // the virtual merge column is appended at the raw width (18)
  const addr = s.columns.find((c) => c.target === 'address_geocode');
  assert.ok(addr && addr.source === 18);
});

test('buildSchema: non-orders entities get no address merge', () => {
  const s = buildSchema('vehicles', { id: 0, plate: 1 }, 10) as { multi_transforms?: unknown };
  assert.equal(s.multi_transforms, undefined);
});

test('buildSchema: time_window_raw adds a regex split -> tw_start/tw_end after the merge', () => {
  const s = buildSchema('orders', { order_no: 0, customer: 4, city: 6, zip: 5, street: 7, time_window_raw: 13 }, 18) as {
    multi_transforms: { type: string; source?: number; target?: string; targets?: { field: string }[] }[];
    columns: { source: number; target: string }[];
  };
  assert.equal(s.multi_transforms.length, 2); // merge + regex
  const rx = s.multi_transforms.find((m) => m.type === 'regex')!;
  assert.equal(rx.source, 13);
  assert.deepEqual(rx.targets?.map((x) => x.field), ['tw_start', 'tw_end']);
  const byT = new Map(s.columns.map((c) => [c.target, c.source]));
  assert.equal(byT.get('address_geocode'), 18); // merge virtual
  assert.equal(byT.get('tw_start'), 19);         // regex virtuals follow
  assert.equal(byT.get('tw_end'), 20);
});

test('missingRequired: reports unmapped required fields', () => {
  assert.deepEqual(missingRequired('orders', { order_no: 0 }).sort(), ['city', 'customer']);
  assert.deepEqual(missingRequired('orders', { order_no: 0, customer: 1, city: 2 }), []);
});

test('suggestMapping: auto-maps Hungarian headers to canonical fields', () => {
  const headers = ['Megrendelés száma', '', 'Fuvarszám', 'Szállítási cím azonosító', 'Szállítási cím megnevezés',
    'Kiszállítási cím: irányítószám', 'Kiszállítási cím: település', 'Kiszállítási cím: utca, házszám'];
  const m = suggestMapping('orders', headers);
  assert.equal(m.order_no, 0);
  assert.equal(m.customer, 4);
  assert.equal(m.zip, 5);
  assert.equal(m.city, 6);
  assert.equal(m.street, 7);
});

const RECONCILE_OK = `--- reconciliation gate ---
=== orders_raw.csv  (schema onboard-orders) ===
  provenance sha256 : OK
  rows reconciled   : 332  (Stage B rejects skipped: 0)
  fields verified   : 3  ['city', 'customer', 'order_no']
  mismatches        : 0
--- semantic sanity (advisory) ---
    [WARN] duplicate-key (1)
    [INFO] zip-shape (16)`;

const RECONCILE_FAIL = `=== x.csv (schema onboard-orders) ===
  provenance sha256 : MISMATCH
  rows reconciled   : 10
  fields verified   : 2  ['a', 'b']
  mismatches        : 2
    MISMATCH row 3 field weight_kg: canonical=5 raw=50
    MISMATCH row 7 field city: canonical=X raw=Y`;

test('parseReconcile: clean gate', () => {
  const r = parseReconcile(RECONCILE_OK);
  assert.equal(r.provenanceOk, true);
  assert.equal(r.rowsReconciled, 332);
  assert.equal(r.mismatches, 0);
  assert.deepEqual(r.fieldsVerified, ['city', 'customer', 'order_no']);
});

test('parseReconcile: failed gate surfaces mismatches', () => {
  const r = parseReconcile(RECONCILE_FAIL);
  assert.equal(r.provenanceOk, false);
  assert.equal(r.mismatches, 2);
  assert.equal(r.mismatchSamples.length, 2);
  assert.ok(r.mismatchSamples[0]!.startsWith('MISMATCH'));
});

test('parseSemantic: counts errors/warnings/info by level', () => {
  const s = parseSemantic(RECONCILE_OK);
  assert.equal(s.errors, 0);
  assert.equal(s.warnings, 1);
  assert.equal(s.info, 16);
  assert.equal(s.items.length, 2);
  assert.deepEqual(s.items[0], { level: 'WARN', kind: 'duplicate-key', count: 1 });
});
