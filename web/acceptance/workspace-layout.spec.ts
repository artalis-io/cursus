import { test, expect } from '@playwright/test';
import { DEFAULT_LAYOUT, DEFAULT_VISIBILITY, HANDLE_SIZE, MAP_MIN_WIDTH, fitLayout, parseLayout, parseVisibility } from '../src/lib/workspace-layout';

test('panel visibility admits only versioned booleans and safely defaults to visible', () => {
  for (const raw of [null, '', '{', 'null', '[]', '{"version":2,"timeline":false}']) expect(parseVisibility(raw)).toEqual(DEFAULT_VISIBILITY);
  expect(parseVisibility('{"version":1,"timeline":false,"kpis":false}')).toEqual({ timeline: false, kpis: false });
  expect(parseVisibility('{"version":1,"timeline":"false","kpis":0}')).toEqual(DEFAULT_VISIBILITY);
  expect(parseVisibility('{"version":1,"timeline":false,"unknown":false}')).toEqual({ timeline: false, kpis: true });
});

test('layout preferences validate versions, types and finite sizes without trusting storage', () => {
  for (const raw of [null, '', '{', 'null', '[]', '"text"', '{"version":2,"fleet":500}']) expect(parseLayout(raw)).toEqual(DEFAULT_LAYOUT);
  expect(parseLayout('{"version":1,"fleet":9999,"inspector":-20,"timeline":"250","email":"ignored"}'))
    .toEqual({ fleet: 520, inspector: 260, timeline: 192 });
  expect(parseLayout('{"version":1,"fleet":1e999,"inspector":333.7,"timeline":250}'))
    .toEqual({ fleet: 310, inspector: 334, timeline: 250 });
});

test('layout always reserves map space at supported desktop widths, including collapsed panels', () => {
  for (const width of [1024, 1100, 1440, 2200]) for (const fleetOpen of [false, true]) for (const inspectorOpen of [false, true]) {
    const layout = fitLayout({ fleet: 520, inspector: 560, timeline: 360 }, width, 700, fleetOpen, inspectorOpen);
    expect(layout.desktop).toBe(true);
    expect(width - layout.fleet - layout.inspector - HANDLE_SIZE * (Number(fleetOpen) + Number(inspectorOpen))).toBeGreaterThanOrEqual(MAP_MIN_WIDTH);
    if (fleetOpen) expect(layout.fleet).toBeGreaterThanOrEqual(240);
    if (inspectorOpen) expect(layout.inspector).toBeGreaterThanOrEqual(260);
    expect(layout.fleetMax).toBeLessThanOrEqual(520);
    expect(layout.inspectorMax).toBeLessThanOrEqual(560);
  }
});

test('small screens retain fixed sizes; resizing a window never rewrites the desktop preference', () => {
  const preferred = { fleet: 500, inspector: 550, timeline: 340 };
  expect(fitLayout(preferred, 375, 500, true, true)).toMatchObject({ ...DEFAULT_LAYOUT, desktop: false });
  fitLayout(preferred, 1024, 220, true, true);
  expect(preferred).toEqual({ fleet: 500, inspector: 550, timeline: 340 });
  expect(fitLayout(preferred, 1800, 800, true, true)).toMatchObject(preferred);
});

test('timeline fits the real remaining workspace after readiness expands, even at very small heights', () => {
  for(const width of [375,600,1440]) for (const height of [0, 80, 120, 200, 300, 700]) {
    const layout = fitLayout(DEFAULT_LAYOUT, width, height, true, true);
    expect(layout.timeline).toBeGreaterThanOrEqual(0);
    expect(layout.timeline).toBeLessThanOrEqual(Math.max(0, height - 120 - HANDLE_SIZE));
    expect(layout.timelineMin).toBeLessThanOrEqual(layout.timelineMax);
  }
});
