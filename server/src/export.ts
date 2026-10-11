import type { Plan, PlanStop, PlanVehicle } from './types.js';

/*
 * Operational exports of a plan: a flat stops CSV (for spreadsheets / TMS
 * import) and a self-contained printable route-sheet HTML (one block per
 * vehicle) that a dispatcher opens and prints to PDF or hands to drivers.
 * Both derive only from the Plan contract, so they inherit anonymization.
 */

function hhmm(sec: number): string {
  if (!Number.isFinite(sec)) return '';
  const m = Math.round(sec / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? '' : String(v);
  // Neutralize spreadsheet formula injection: a cell starting with = + - @ tab
  // or CR is evaluated by Excel/Sheets, and customer/city/order fields come from
  // untrusted uploaded data. Prefix a quote so it's treated as text. Genuine
  // numbers (incl. negative coordinates) are left alone.
  if (!/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

const CSV_HEADER = [
  'status', 'vehicle_ref', 'vehicle_class', 'trip', 'seq', 'order_no', 'customer', 'city',
  'lon', 'lat', 'arrival', 'service_start', 'departure', 'tw_start', 'tw_end',
  'pallets', 'weight_kg', 'late_min',
];

export function planToCsv(plan: Plan): string {
  const rows: string[] = [CSV_HEADER.join(',')];
  for (const v of plan.vehicles) {
    for (const trip of v.trips) {
      for (const s of trip.stops) {
        rows.push([
          'assigned', v.ref, v.vehicleClass ?? '', trip.index + 1, s.seq, s.orderNo, s.customer ?? '', s.city ?? '',
          s.lon.toFixed(6), s.lat.toFixed(6), hhmm(s.arrivalSec), hhmm(s.serviceStartSec), hhmm(s.departureSec),
          hhmm(s.twStartSec), hhmm(s.twEndSec), round1(s.pallets), Math.round(s.weightKg),
          s.lateBySec > 0 ? Math.round(s.lateBySec / 60) : 0,
        ].map(csvCell).join(','));
      }
    }
  }
  for (const u of plan.unassigned) {
    rows.push([
      'unassigned', '', '', '', '', u.orderNo, u.customer ?? '', u.city ?? '',
      u.lon != null ? u.lon.toFixed(6) : '', u.lat != null ? u.lat.toFixed(6) : '',
      '', '', '', '', '', '', '', '',
    ].map(csvCell).join(','));
  }
  return rows.join('\n') + '\n';
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function lateMin(sec: number): number { return sec > 0 ? Math.round(sec / 60) : 0; }

/* Outbound handoff: write the tuned plan back in the customer's route schema
 * (the inverse of ingest). The columns mirror the `routes` canonical
 * (order_no, vehicle, sequence, date) so this CSV re-imports through the same
 * onboarding pipeline, with the planned times/trip as value-add. `sequence` is
 * the 1-based visit order on the vehicle across all its trips. */
const ROUTES_HEADER = [
  'order_no', 'vehicle', 'sequence', 'date', 'vehicle_class', 'trip',
  'planned_arrival', 'planned_departure', 'service_min', 'late_min', 'status',
];
export function planToRoutesCsv(plan: Plan, isoDate: string): string {
  const rows: string[] = [ROUTES_HEADER.join(',')];
  for (const v of plan.vehicles) {
    let seq = 0;
    for (const trip of v.trips) {
      for (const s of trip.stops) {
        seq++;
        rows.push([
          s.orderNo, v.ref, seq, isoDate, v.vehicleClass ?? '', trip.index + 1,
          hhmm(s.arrivalSec), hhmm(s.departureSec), s.serviceMin, lateMin(s.lateBySec), 'assigned',
        ].map(csvCell).join(','));
      }
    }
  }
  for (const u of plan.unassigned) {
    rows.push([u.orderNo, '', '', isoDate, '', '', '', '', '', '', 'unassigned'].map(csvCell).join(','));
  }
  return rows.join('\n') + '\n';
}

/* A clean, documented dispatch-plan document for programmatic handoff (not the
 * raw internal Plan, which carries geometry + provenance). */
export interface HandoffPlan {
  otto_dispatch_plan: 1;
  day: string; date: string; generatedAt: string; objective: string;
  summary: { vehiclesUsed: number; servedOrders: number; totalOrders: number; totalDistanceKm: number; cost: { currency: string; total: number; source: string } | null };
  routes: { vehicle: string; vehicleClass: string | null; isSubcontractor: boolean; distanceKm: number; finishTime: string;
    stops: { sequence: number; trip: number; orderNo: string; customer: string | null; city: string | null; plannedArrival: string; plannedDeparture: string; serviceMin: number; lateMin: number; weightKg: number; pallets: number }[] }[];
  unassigned: { orderNo: string; customer: string | null; city: string | null; reason: string | null }[];
}
export function planToHandoffJson(plan: Plan, isoDate: string): HandoffPlan {
  return {
    otto_dispatch_plan: 1,
    day: plan.day, date: isoDate, generatedAt: plan.createdAt,
    objective: plan.objective === 'distance' ? 'least_distance' : 'fewest_vehicles',
    summary: {
      vehiclesUsed: plan.stats.vehiclesUsed, servedOrders: plan.stats.servedOrders, totalOrders: plan.stats.totalOrders,
      totalDistanceKm: round1(plan.stats.totalDistanceKm),
      cost: plan.cost ? { currency: plan.cost.currency, total: Math.round(plan.cost.total), source: plan.cost.source } : null,
    },
    routes: plan.vehicles.map((v) => {
      let seq = 0;
      return {
        vehicle: v.ref, vehicleClass: v.vehicleClass, isSubcontractor: v.isSubcontractor,
        distanceKm: round1(v.distanceKm), finishTime: hhmm(v.finishTimeSec),
        stops: v.trips.flatMap((tr) => tr.stops.map((s) => ({
          sequence: ++seq, trip: tr.index + 1, orderNo: s.orderNo, customer: s.customer, city: s.city,
          plannedArrival: hhmm(s.arrivalSec), plannedDeparture: hhmm(s.departureSec),
          serviceMin: s.serviceMin, lateMin: lateMin(s.lateBySec), weightKg: Math.round(s.weightKg), pallets: round1(s.pallets),
        }))),
      };
    }),
    unassigned: plan.unassigned.map((u) => ({ orderNo: u.orderNo, customer: u.customer, city: u.city, reason: u.reasonCode })),
  };
}

/* Google Maps directions URL: depot -> stops -> depot (capped to the URL's
 * practical waypoint limit). Lets a driver open turn-by-turn navigation. */
function mapsUrl(plan: Plan, stops: PlanStop[]): string {
  const depot = `${plan.depot.lat.toFixed(5)},${plan.depot.lon.toFixed(5)}`;
  const pts = [depot, ...stops.slice(0, 22).map((s) => `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`), depot];
  return `https://www.google.com/maps/dir/${pts.join('/')}`;
}

function money(n: number, currency: string): string {
  return `${Math.round(n).toLocaleString('en-US')} ${currency}`;
}

function vehicleBlock(plan: Plan, v: PlanVehicle): string {
  const cost = plan.cost?.perVehicle.find((c) => c.vehicleId === v.id);
  const trips = v.trips.map((trip) => {
    const rows = trip.stops.map((s) => `
      <tr${s.lateBySec > 0 ? ' class="late"' : ''}>
        <td class="n">${s.seq}</td>
        <td>${esc(s.customer ?? s.orderNo)}<div class="sub">#${esc(s.orderNo)}${s.city ? ` · ${esc(s.city)}` : ''}</div></td>
        <td class="n">${hhmm(s.arrivalSec)}</td>
        <td class="n">${hhmm(s.twStartSec)}–${hhmm(s.twEndSec)}</td>
        <td class="n">${round1(s.pallets)}</td>
        <td class="n">${Math.round(s.weightKg).toLocaleString('en-US')}</td>
      </tr>`).join('');
    return `
      <div class="trip">
        <div class="trip-h">
          <strong>Trip ${trip.index + 1}</strong>
          <span>${hhmm(trip.startSec)}–${hhmm(trip.endSec)} · ${trip.distanceKm.toFixed(1)} km · ${round1(trip.loadPallets)} plt / ${Math.round(trip.loadKg).toLocaleString('en-US')} kg</span>
          <a class="nav" href="${mapsUrl(plan, trip.stops)}" target="_blank" rel="noopener">Open in Maps ↗</a>
        </div>
        <table>
          <thead><tr><th>#</th><th>Stop</th><th>ETA</th><th>Window</th><th>Plt</th><th>Kg</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join('');
  return `
    <section class="veh">
      <div class="veh-h">
        <span class="swatch" style="background:${v.color}"></span>
        <h2>${esc(v.ref)}</h2>
        ${v.vehicleClass ? `<span class="tag">${esc(v.vehicleClass.replace(/_/g, ' '))}</span>` : ''}
        ${v.isSubcontractor ? '<span class="tag sub">subcontractor</span>' : ''}
        <span class="veh-stats">${v.tripCount} trip(s) · ${v.distanceKm.toFixed(1)} km · finish ${hhmm(v.finishTimeSec)}${cost ? ` · ${money(cost.totalCost, plan.cost!.currency)}` : ''}</span>
      </div>
      ${trips}
    </section>`;
}

export function planToRouteSheetHtml(plan: Plan, dayLabel: string): string {
  const s = plan.stats;
  const costLine = plan.cost ? ` · est. ${money(plan.cost.total, plan.cost.currency)}${plan.cost.source === 'demo' ? ' (demo tariff)' : ''}` : '';
  const unassigned = plan.unassigned.length
    ? `<section class="veh"><div class="veh-h"><h2>Unassigned (${plan.unassigned.length})</h2></div>
        <table><thead><tr><th>Order</th><th>Customer</th><th>City</th></tr></thead><tbody>
        ${plan.unassigned.map((u) => `<tr><td class="n">#${esc(u.orderNo)}</td><td>${esc(u.customer ?? '')}</td><td>${esc(u.city ?? '')}</td></tr>`).join('')}
        </tbody></table></section>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Route sheets — ${esc(dayLabel)}</title>
<style>
  :root { --ink:#1b2430; --muted:#6b7684; --line:#e3e7ec; --warn:#d97706; }
  * { box-sizing: border-box; }
  body { font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); margin: 0; padding: 24px; background:#f6f7f9; }
  header.doc { margin-bottom: 18px; }
  header.doc h1 { font-size: 18px; margin: 0 0 2px; }
  header.doc .meta { color: var(--muted); font-size: 12px; }
  .veh { background:#fff; border:1px solid var(--line); border-radius:8px; margin-bottom:14px; padding:12px 14px; page-break-inside: avoid; }
  .veh-h { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .veh-h h2 { font-size:15px; margin:0; }
  .swatch { width:12px; height:12px; border-radius:3px; display:inline-block; }
  .tag { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:1px 5px; }
  .tag.sub { color:var(--warn); border-color:var(--warn); }
  .veh-stats { margin-left:auto; color:var(--muted); font-size:11px; font-variant-numeric: tabular-nums; }
  .trip { margin-top:8px; }
  .trip-h { display:flex; align-items:baseline; gap:10px; font-size:12px; margin-bottom:3px; }
  .trip-h span { color:var(--muted); }
  .trip-h .nav { margin-left:auto; color:#2563eb; text-decoration:none; font-size:11px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:3px 6px; border-bottom:1px solid var(--line); }
  th { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600; }
  td.n, th:first-child { font-variant-numeric: tabular-nums; }
  td.n { white-space:nowrap; }
  .sub { color:var(--muted); font-size:10px; }
  tr.late td { color:var(--warn); }
  @media print { body { background:#fff; padding:0; } .trip-h .nav { display:none; } .veh { border:none; border-bottom:1px solid var(--line); border-radius:0; } }
</style></head><body>
<header class="doc">
  <h1>Route sheets — ${esc(dayLabel)}</h1>
  <div class="meta">${s.vehiclesUsed} vehicles · ${s.servedOrders}/${s.totalOrders} orders · ${s.totalDistanceKm.toFixed(0)} km · objective: ${plan.objective === 'distance' ? 'least distance' : 'fewest vehicles'}${costLine}</div>
</header>
${plan.vehicles.map((v) => vehicleBlock(plan, v)).join('')}
${unassigned}
</body></html>`;
}
