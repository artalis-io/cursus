import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, {
  Layer, Source, type MapRef, type LayerProps, type MapLayerMouseEvent,
} from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import { Minus, Plus, Maximize2 } from 'lucide-react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { cartaStyle } from './cartaStyle';
import { useT } from '@/i18n';
import type { Plan, Scenario, Selection, Vehicle } from '@/types';

/*
 * The dispatch map. Basemap is the reused "Carta Quiet" style; routes, stops and
 * the depot are declarative overlays. Selection drives styling (highlight the
 * selected vehicle/trip, fade the rest) and the camera (fit on deliberate
 * selection; preserved across background plan updates like geometry fills).
 *
 * transformRequest is load-bearing (copied from the Carta viewer): the style's
 * root-relative tile/glyph URLs fail to parse inside MapLibre's Web Worker, so
 * we resolve them against the page origin.
 */

const transformRequest = (url: string) => ({ url: url.startsWith('/') ? window.location.origin + url : url });

function routesFC(plan: Plan): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: plan.vehicles.flatMap((v) =>
      v.trips.filter((t) => t.geometry).map((t) => ({
        type: 'Feature' as const,
        id: v.id * 100 + t.index,
        properties: { vehicleId: v.id, color: v.color, tripIndex: t.index },
        geometry: t.geometry as LineString,
      }))),
  };
}
function stopsFC(plan: Plan): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: plan.vehicles.flatMap((v) =>
      v.trips.flatMap((t) =>
        t.stops.map((s) => ({
          type: 'Feature' as const,
          properties: { vehicleId: v.id, color: v.color, tripIndex: t.index, seq: s.seq },
          geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
        })))),
  };
}
function pointFC(lon: number, lat: number, props: Record<string, unknown> = {}): FeatureCollection {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } }] };
}

function centroid(v: Vehicle): [number, number] | null {
  const pts: [number, number][] = [];
  for (const t of v.trips) for (const s of t.stops) pts.push([s.lon, s.lat]);
  if (!pts.length) return null;
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}

/* "Ghost" overlay for the staged (not-yet-replanned) edits so the dispatcher can
 * see a pending change spatially before committing it:
 *  - a reassignment (a pin moving an order to a different vehicle) draws a dashed
 *    line from the order's current location to the target vehicle's cluster, plus
 *    a ghost ring at the order in the target vehicle's colour;
 *  - a reorder (a non-locked staged sequence) draws a dashed straight-line path
 *    through the new stop order (depot -> stops -> depot) in the vehicle's colour.
 * Straight lines, not road geometry: the real roads only exist once Surge solves. */
function ghostFCs(plan: Plan, scenario: Scenario | null | undefined): { lines: FeatureCollection; points: FeatureCollection } {
  const lineFeats: FeatureCollection['features'] = [];
  const pointFeats: FeatureCollection['features'] = [];
  if (scenario) {
    // NB: the default `Map` import here is react-map-gl's component, so the
    // collection type must be reached via globalThis.
    const vehById = new globalThis.Map(plan.vehicles.map((v) => [v.id, v] as const));
    const stopLoc = new globalThis.Map<string, [number, number]>();
    const orderVeh = new globalThis.Map<string, number>();
    for (const v of plan.vehicles) for (const t of v.trips) for (const s of t.stops) { stopLoc.set(s.orderNo, [s.lon, s.lat]); orderVeh.set(s.orderNo, v.id); }
    const unLoc = new globalThis.Map<string, [number, number]>();
    for (const u of plan.unassigned) if (typeof u.lon === 'number' && typeof u.lat === 'number') unLoc.set(u.orderNo, [u.lon, u.lat]);

    for (const p of scenario.pins) {
      if (orderVeh.get(p.orderNo) === p.vehicleId) continue;              // already on the target vehicle
      const from = stopLoc.get(p.orderNo) ?? unLoc.get(p.orderNo);
      const target = vehById.get(p.vehicleId);
      const to = target ? centroid(target) : null;
      if (!from || !target || !to) continue;
      lineFeats.push({ type: 'Feature', properties: { color: target.color, kind: 'move' }, geometry: { type: 'LineString', coordinates: [from, to] } });
      pointFeats.push({ type: 'Feature', properties: { color: target.color }, geometry: { type: 'Point', coordinates: from } });
    }

    for (const q of scenario.sequences) {
      if (q.locked) continue;
      const v = vehById.get(q.vehicleId);
      if (!v) continue;
      const current = v.trips.flatMap((t) => t.stops.map((s) => s.orderNo));
      if (current.length === q.orderNos.length && current.every((o, i) => o === q.orderNos[i])) continue; // unchanged
      const coords = q.orderNos.map((o) => stopLoc.get(o)).filter(Boolean) as [number, number][];
      if (coords.length < 2) continue;
      const path: [number, number][] = [[plan.depot.lon, plan.depot.lat], ...coords, [plan.depot.lon, plan.depot.lat]];
      lineFeats.push({ type: 'Feature', properties: { color: v.color, kind: 'reorder' }, geometry: { type: 'LineString', coordinates: path } });
    }
  }
  return { lines: { type: 'FeatureCollection', features: lineFeats }, points: { type: 'FeatureCollection', features: pointFeats } };
}

function selVehicle(sel: Selection): number | null {
  return sel && sel.kind !== 'unassigned' ? sel.vehicleId : null;
}
function selTripIndex(sel: Selection): number | null {
  return sel && (sel.kind === 'trip' || sel.kind === 'stop') ? sel.tripIndex : null;
}

/* A trip's road geometry annotated with a time->distance schedule, so a marker
 * can be placed where the truck actually is at a given clock: moving along the
 * road during travel legs, parked at a stop during its wait+service. */
interface TripSchedule { coords: [number, number][]; cum: number[]; anchors: { t: number; len: number }[] }

function buildSchedules(plan: Plan): Record<string, TripSchedule> {
  const m: Record<string, TripSchedule> = {};
  for (const v of plan.vehicles) {
    for (const t of v.trips) {
      const coords = (t.geometry?.coordinates ?? []) as [number, number][];
      if (coords.length < 2) continue;
      const cum = [0];
      for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1]! + Math.hypot(coords[i]![0] - coords[i - 1]![0], coords[i]![1] - coords[i - 1]![1]);
      const total = cum[cum.length - 1]!;
      // Anchors map schedule times to a distance along the road. A stop occupies
      // two anchors at the same distance (arrival -> departure) so the marker parks.
      const anchors: { t: number; len: number }[] = [{ t: t.startSec, len: 0 }];
      let startIdx = 0, prevLen = 0;
      for (const s of t.stops) {
        let bestI = startIdx, bestD = Infinity;                 // nearest geometry vertex, searched forward (monotonic)
        for (let i = startIdx; i < coords.length; i++) { const d = Math.hypot(coords[i]![0] - s.lon, coords[i]![1] - s.lat); if (d < bestD) { bestD = d; bestI = i; } }
        const len = Math.max(prevLen, cum[bestI]!);
        anchors.push({ t: s.arrivalSec, len });
        anchors.push({ t: s.departureSec, len });
        startIdx = bestI; prevLen = len;
      }
      anchors.push({ t: t.endSec, len: total });
      m[`${v.id}:${t.index}`] = { coords, cum, anchors };
    }
  }
  return m;
}

function pointAtLength(coords: [number, number][], cum: number[], len: number): [number, number] {
  const total = cum[cum.length - 1]!;
  if (len <= 0) return coords[0]!;
  if (len >= total) return coords[coords.length - 1]!;
  let lo = 1, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid]! < len) lo = mid + 1; else hi = mid; }
  const seg = cum[lo]! - cum[lo - 1]!;
  const r = seg > 0 ? (len - cum[lo - 1]!) / seg : 0;
  return [coords[lo - 1]![0] + (coords[lo]![0] - coords[lo - 1]![0]) * r, coords[lo - 1]![1] + (coords[lo]![1] - coords[lo - 1]![1]) * r];
}

function positionAt(sch: TripSchedule, clock: number): [number, number] {
  const a = sch.anchors;
  if (clock <= a[0]!.t) return sch.coords[0]!;
  if (clock >= a[a.length - 1]!.t) return sch.coords[sch.coords.length - 1]!;
  let k = 0;
  while (k < a.length - 1 && clock > a[k + 1]!.t) k++;
  const span = a[k + 1]!.t - a[k]!.t;
  const frac = span > 0 ? (clock - a[k]!.t) / span : 0;
  const len = a[k]!.len + frac * (a[k + 1]!.len - a[k]!.len);
  return pointAtLength(sch.coords, sch.cum, len);
}

/* Active vehicle positions at `clockSec`, placed by the trip's time->distance
 * schedule (travel along the road, park during service). Restricted to the
 * selected vehicle/trip so markers match the visible (non-faded) routes. */
function playheadFC(plan: Plan, clockSec: number | null, selVId: number | null, selTIdx: number | null, schedules: Record<string, TripSchedule>): FeatureCollection {
  const features: FeatureCollection['features'] = [];
  if (clockSec == null) return { type: 'FeatureCollection', features };
  for (const v of plan.vehicles) {
    if (selVId != null && v.id !== selVId) continue;
    for (const t of v.trips) {
      if (clockSec < t.startSec || clockSec > t.endSec) continue;
      if (selTIdx != null && t.index !== selTIdx) continue;
      const sch = schedules[`${v.id}:${t.index}`];
      if (!sch) continue;
      const [lon, lat] = positionAt(sch, clockSec);
      features.push({ type: 'Feature', properties: { color: v.color, ref: v.ref }, geometry: { type: 'Point', coordinates: [lon, lat] } });
      break;
    }
  }
  return { type: 'FeatureCollection', features };
}

export function MapView({ plan, scenario, selection, onSelect, clockSec, visibleVehicleIds }: { plan: Plan; scenario?: Scenario | null; selection: Selection; onSelect: (s: Selection) => void; clockSec: number | null; visibleVehicleIds?: number[] | null }) {
  const mapRef = useRef<MapRef | null>(null);
  // Respect reduced-motion: snap the camera instead of animating.
  const reduced = useRef(typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const dur = (ms: number) => (reduced.current ? 0 : ms);
  const style = useMemo(() => cartaStyle(), []);
  const routes = useMemo(() => routesFC(plan), [plan]);
  const stops = useMemo(() => stopsFC(plan), [plan]);
  const depot = useMemo(() => pointFC(plan.depot.lon, plan.depot.lat), [plan.depot.lon, plan.depot.lat]);
  const schedules = useMemo(() => buildSchedules(plan), [plan]);
  const playhead = useMemo(() => playheadFC(plan, clockSec, selVehicle(selection), selTripIndex(selection), schedules), [plan, clockSec, selection, schedules]);
  const ghost = useMemo(() => ghostFCs(plan, scenario), [plan, scenario]);
  const [hovering, setHovering] = useState(false);
  const t = useT();

  const vId = selVehicle(selection);
  const tIdx = selTripIndex(selection);

  // Fleet-panel filter (tail-lift / advisories / search): restrict rendered
  // routes + stops to the matching vehicles. null = no filter (show all). An
  // empty set hides everything. Applied as a layer filter so filtered-out
  // features are neither drawn nor clickable; selection highlighting still
  // works within what remains.
  const layerFilter = useMemo(
    () => (visibleVehicleIds ? (['in', ['get', 'vehicleId'], ['literal', visibleVehicleIds]] as unknown) : undefined),
    [visibleVehicleIds],
  );

  // Match expression for the selected subset (vehicle, or vehicle+trip).
  const match = useMemo(() => {
    if (vId == null) return null;
    return tIdx == null
      ? (['==', ['get', 'vehicleId'], vId] as unknown)
      : (['all', ['==', ['get', 'vehicleId'], vId], ['==', ['get', 'tripIndex'], tIdx]] as unknown);
  }, [vId, tIdx]);

  const routeCasing: LayerProps = useMemo(() => ({
    id: 'route-casing', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' },
    ...(layerFilter ? { filter: layerFilter as never } : {}),
    paint: {
      'line-color': '#223a2e',
      'line-width': match ? (['case', match, 8, 4] as never) : 6,
      'line-opacity': match ? (['case', match, 0.9, 0.05] as never) : 0.85,
    },
  }), [match, layerFilter]);
  const routeLine: LayerProps = useMemo(() => ({
    id: 'route-line', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' },
    ...(layerFilter ? { filter: layerFilter as never } : {}),
    paint: {
      'line-color': ['get', 'color'],
      'line-width': match ? (['case', match, 5, 2.5] as never) : 4,
      'line-opacity': match ? (['case', match, 0.98, 0.1] as never) : 0.92,
    },
  }), [match, layerFilter]);
  const stopLayer: LayerProps = useMemo(() => ({
    id: 'stops', type: 'circle',
    ...(layerFilter ? { filter: layerFilter as never } : {}),
    paint: {
      'circle-radius': 4.5,
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fbfaf5',
      'circle-stroke-width': 1.2,
      'circle-opacity': match ? (['case', match, 1, 0.1] as never) : 0.95,
      'circle-stroke-opacity': match ? (['case', match, 1, 0.1] as never) : 0.9,
    },
  }), [match, layerFilter]);

  const depotLayer: LayerProps = { id: 'depot', type: 'circle', paint: { 'circle-radius': 7, 'circle-color': '#223a2e', 'circle-stroke-color': '#fbfaf5', 'circle-stroke-width': 2.5 } };

  // Selected stop highlight ring.
  const selectedStop = useMemo(() => {
    if (!selection || selection.kind !== 'stop') return null;
    const v = plan.vehicles.find((x) => x.id === selection.vehicleId);
    const t = v?.trips.find((x) => x.index === selection.tripIndex);
    const s = t?.stops.find((x) => x.seq === selection.seq);
    return s ? pointFC(s.lon, s.lat, { color: v!.color }) : null;
  }, [selection, plan]);

  // Unassigned orders (if coords available) as muted hollow markers.
  const unassignedFC = useMemo<FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: plan.unassigned
      .filter((u) => typeof (u as { lon?: number }).lon === 'number')
      .map((u) => ({ type: 'Feature', properties: { orderNo: u.orderNo },
        geometry: { type: 'Point', coordinates: [(u as { lon: number }).lon, (u as { lat: number }).lat] } })),
  }), [plan.unassigned]);

  const fitTo = useCallback((coords: [number, number][], padding = 70) => {
    const map = mapRef.current; if (!map || coords.length === 0) return;
    const b = new maplibregl.LngLatBounds();
    for (const c of coords) b.extend(c);
    map.fitBounds(b, { padding, duration: dur(500), maxZoom: 15 });
  }, []);

  const allCoords = useCallback((): [number, number][] => {
    const cs: [number, number][] = [[plan.depot.lon, plan.depot.lat]];
    for (const v of plan.vehicles) for (const t of v.trips) if (t.geometry) for (const c of t.geometry.coordinates) cs.push(c as [number, number]);
    return cs;
  }, [plan]);

  const fitAll = useCallback(() => fitTo(allCoords(), 60), [fitTo, allCoords]);

  // Camera: fit to the selection on deliberate selection change; fit all when a
  // new plan is loaded. Not re-run on background geometry fills (dep on plan.id).
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    if (!selection || selection.kind === 'unassigned') { fitAll(); return; }
    const v = plan.vehicles.find((x) => x.id === selection.vehicleId);
    if (!v) return;
    if (selection.kind === 'vehicle') {
      fitTo(v.trips.flatMap((t) => (t.geometry?.coordinates ?? []) as [number, number][]));
    } else if (selection.kind === 'trip') {
      const t = v.trips.find((x) => x.index === selection.tripIndex);
      fitTo((t?.geometry?.coordinates ?? []) as [number, number][]);
    } else {
      const t = v.trips.find((x) => x.index === selection.tripIndex);
      const s = t?.stops.find((x) => x.seq === selection.seq);
      if (s) map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 13), duration: dur(500) });
    }
    // Intentionally keyed on selection identity + plan.id only (see comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey(selection), plan.id]);

  const onClick = useCallback((e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) { onSelect(null); return; }
    const p = f.properties as { vehicleId?: number; tripIndex?: number; seq?: number } | null;
    if (f.layer.id === 'stops' && p?.vehicleId != null) {
      onSelect({ kind: 'stop', vehicleId: p.vehicleId, tripIndex: p.tripIndex ?? 0, seq: p.seq ?? 1 });
    } else if ((f.layer.id === 'route-line' || f.layer.id === 'route-hit') && p?.vehicleId != null) {
      onSelect({ kind: 'trip', vehicleId: p.vehicleId, tripIndex: p.tripIndex ?? 0 });
    }
  }, [onSelect]);

  const zoomBy = (d: number) => { const m = mapRef.current; if (m) m.easeTo({ zoom: m.getZoom() + d, duration: dur(200) }); };

  return (
    <div className="relative h-full w-full">
      <Map
        ref={mapRef}
        initialViewState={{ longitude: plan.depot.lon, latitude: plan.depot.lat, zoom: 9 }}
        mapStyle={style}
        transformRequest={transformRequest}
        attributionControl={false}
        interactiveLayerIds={['stops', 'route-hit', 'route-line']}
        cursor={hovering ? 'pointer' : 'default'}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onClick={onClick}
        onLoad={fitAll}
        style={{ position: 'absolute', inset: 0 }}
      >
        <Source id="routes" type="geojson" data={routes}>
          {/* wide transparent hit target so thin routes are easy to click */}
          <Layer id="route-hit" type="line" {...(layerFilter ? { filter: layerFilter as never } : {})} paint={{ 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 }} />
          <Layer {...routeCasing} />
          <Layer {...routeLine} />
        </Source>
        {ghost.lines.features.length > 0 && (
          <Source id="ghost-lines" type="geojson" data={ghost.lines}>
            <Layer id="ghost-line" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.9, 'line-dasharray': [1.6, 1.4] }} />
          </Source>
        )}
        {ghost.points.features.length > 0 && (
          <Source id="ghost-points" type="geojson" data={ghost.points}>
            <Layer id="ghost-point" type="circle"
              paint={{ 'circle-radius': 7, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2.5, 'circle-stroke-opacity': 0.95 }} />
          </Source>
        )}
        {unassignedFC.features.length > 0 && (
          <Source id="unassigned" type="geojson" data={unassignedFC}>
            <Layer id="unassigned" type="circle" paint={{ 'circle-radius': 5, 'circle-color': '#b4572a', 'circle-opacity': 0.25, 'circle-stroke-color': '#b4572a', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.8 }} />
          </Source>
        )}
        <Source id="stops" type="geojson" data={stops}>
          <Layer {...stopLayer} />
        </Source>
        {selectedStop && (
          <Source id="selstop" type="geojson" data={selectedStop}>
            <Layer id="selstop-ring" type="circle" paint={{ 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2.5 }} />
          </Source>
        )}
        <Source id="depot" type="geojson" data={depot}>
          <Layer {...depotLayer} />
        </Source>
        {playhead.features.length > 0 && (
          <Source id="playhead" type="geojson" data={playhead}>
            <Layer id="playhead-halo" type="circle" paint={{ 'circle-radius': 9, 'circle-color': ['get', 'color'], 'circle-opacity': 0.25 }} />
            <Layer id="playhead-dot" type="circle" paint={{ 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#111', 'circle-stroke-width': 1.5 }} />
          </Source>
        )}
      </Map>

      <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-md bg-graphite/80 text-graphite-foreground shadow-lg backdrop-blur-sm">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1)} className="flex h-8 w-8 items-center justify-center hover:bg-white/10"><Plus className="h-4 w-4" /></button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(-1)} className="flex h-8 w-8 items-center justify-center border-t border-white/10 hover:bg-white/10"><Minus className="h-4 w-4" /></button>
        <button type="button" aria-label="Fit plan" onClick={() => { onSelect(null); fitAll(); }} className="flex h-8 w-8 items-center justify-center border-t border-white/10 hover:bg-white/10"><Maximize2 className="h-4 w-4" /></button>
      </div>

      {ghost.lines.features.length > 0 && (
        <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-md bg-graphite/80 px-2.5 py-1 text-[11px] text-graphite-foreground shadow-lg backdrop-blur-sm">
          <svg width="20" height="2" aria-hidden className="shrink-0"><line x1="0" y1="1" x2="20" y2="1" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2" /></svg>
          {t('map.ghostLegend')}
        </div>
      )}
    </div>
  );
}

function selectionKey(s: Selection): string {
  if (!s) return 'none';
  if (s.kind === 'unassigned') return `u:${s.orderNo}`;
  if (s.kind === 'vehicle') return `v:${s.vehicleId}`;
  if (s.kind === 'trip') return `t:${s.vehicleId}:${s.tripIndex}`;
  return `s:${s.vehicleId}:${s.tripIndex}:${s.seq}`;
}
