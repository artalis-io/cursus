import { Ban, CheckCircle2, AlertTriangle, Pin, PinOff, X, RotateCcw, SlidersHorizontal, ChevronRight, ChevronUp, ChevronDown, ArrowLeft, ArrowRight, Lock, LockOpen, GripVertical, ListOrdered, Loader2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { hhmm, km, money, pct, ratio } from '@/lib/format';
import { setDraggedOrder, isOrderDrag, readDraggedOrder } from '@/lib/dnd';
import { violationDetail } from '@/lib/violations';
import { NarrationPanel } from '@/components/NarrationPanel';
import { api } from '@/lib/api';
import { useT } from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import type { Plan, Scenario, Selection, Vehicle, Trip, Stop, ValidationViolation, VehicleConstraintPatch } from '@/types';

function Field({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tnum font-medium ${warn ? 'text-warning' : ''}`}>{value}</span>
    </div>
  );
}
const kg = (n: number) => `${Math.round(n).toLocaleString('en-US')} kg`;
const plt = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString('en-US')} plt`;

function StopDetail({ stop, vehicle }: { stop: Stop; vehicle: Vehicle }) {
  const t = useT();
  const late = stop.lateBySec > 0;
  const tailLiftMiss = stop.requiresTailLift && !vehicle.hasTailLift;
  const sizeMiss = stop.maxTonnage != null && vehicle.tonnage != null && vehicle.tonnage > stop.maxTonnage + 0.01;
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-semibold">{stop.customer ?? `Order ${stop.orderNo}`}</div>
        <div className="tnum text-xs text-muted-foreground">#{stop.orderNo}{stop.city ? ` · ${stop.city}` : ''}</div>
      </div>
      {(stop.requiresTailLift || stop.maxTonnage != null) && (
        <div className="flex flex-wrap gap-1">
          {stop.requiresTailLift && <Badge variant={tailLiftMiss ? 'warning' : 'outline'} className="gap-1 text-[10px]">{tailLiftMiss && <AlertTriangle className="h-3 w-3" />}{t('constraint.tailLift')}</Badge>}
          {stop.maxTonnage != null && <Badge variant={sizeMiss ? 'warning' : 'outline'} className="gap-1 text-[10px]">{sizeMiss && <AlertTriangle className="h-3 w-3" />}{t('constraint.maxT', { n: stop.maxTonnage })}</Badge>}
        </div>
      )}
      {(tailLiftMiss || sizeMiss) && (
        <div className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning">
          {tailLiftMiss && <div>{t('constraint.tailLiftMiss', { ref: vehicle.ref })}</div>}
          {sizeMiss && <div>{t('constraint.sizeMiss', { t: vehicle.tonnage ?? 0, max: stop.maxTonnage ?? 0 })}</div>}
        </div>
      )}
      <Separator />
      <Field label={t('inspector.arrival')} value={hhmm(stop.arrivalSec)} warn={late} />
      <Field label={t('inspector.service')} value={`${hhmm(stop.serviceStartSec)}–${hhmm(stop.departureSec)}`} />
      <Field label={t('inspector.timeWindow')} value={`${hhmm(stop.twStartSec)}–${hhmm(stop.twEndSec)}`} />
      {stop.waitSec > 0 && <Field label={t('inspector.wait')} value={t('inspector.minN', { n: Math.round(stop.waitSec / 60) })} />}
      {late && <Field label={t('inspector.lateBy')} value={t('inspector.minN', { n: Math.round(stop.lateBySec / 60) })} warn />}
      <Separator />
      <Field label={t('inspector.weight')} value={kg(stop.weightKg)} />
      <Field label={t('inspector.pallets')} value={plt(stop.pallets)} />
      <Field label={t('inspector.serviceTime')} value={t('inspector.minN', { n: stop.serviceMin })} />
      <Field label={t('inspector.travelTo')} value={t('inspector.minN', { n: Math.round(stop.travelToSec / 60) })} />
    </div>
  );
}

/* A best-effort explanation of why the trip is ordered as it is: whether the
 * sequence is driven by delivery time windows (most stops windowed) or by
 * distance, plus how many stops are tight / late / waiting. Computed from the
 * stop timings the solver produced (Surge emits no rationale). */
function routeRationale(trip: Trip): { windowDriven: boolean; tight: number; late: number; waits: number } {
  let windowed = 0, tight = 0, late = 0, waits = 0;
  for (const s of trip.stops) {
    const hasWindow = s.twEndSec < 86_400 || s.twStartSec > 0;
    if (hasWindow) windowed++;
    if (s.lateBySec > 1) late++;
    else if (hasWindow && s.twEndSec - s.arrivalSec < 1800) tight++; // <30 min slack
    if (s.waitSec > 60) waits++;
  }
  return { windowDriven: windowed >= Math.ceil(trip.stops.length / 2), tight, late, waits };
}

/* Reorder a trip's stops to match a staged sequence (order numbers), stable for
 * any stop not named in it. Used to reflect a drag-reorder in the list before
 * Replan (the plan itself only changes on Replan). */
function reorderTripStops(trip: Trip, orderNos: string[]): Trip {
  const pos = new Map(orderNos.map((o, i) => [o, i]));
  const stops = [...trip.stops].sort((a, b) => (pos.get(a.orderNo) ?? Infinity) - (pos.get(b.orderNo) ?? Infinity));
  return { ...trip, stops };
}

/* Recompute a reordered trip's schedule/distance/cost on the backend (which holds
 * the travel matrix + tariff), without a re-solve. Returns the recomputed trip
 * once ready, so the Inspector shows real preview numbers instead of blanks. The
 * request is keyed by the proposed order; a stale response is dropped. */
function useReorderPreview(
  planId: string, vehicleId: number, base: Trip | undefined, orderNos: string[], enabled: boolean,
): { trip: Trip | null; loading: boolean; error: boolean } {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const key = enabled && base ? `${planId}|${vehicleId}|${base.index}|${orderNos.join(',')}` : '';
  const latest = useRef('');
  useEffect(() => {
    latest.current = key;
    if (!key || !base) { setTrip(null); setLoading(false); setError(false); return; }
    setLoading(true); setError(false);
    let cancelled = false;
    api.evaluateTrip(planId, { vehicleId, tripIndex: base.index, startSec: base.startSec, reloadSecAfter: base.reloadSecAfter, orderNos })
      .then((r) => { if (!cancelled && latest.current === key) { setTrip(r.trip); setLoading(false); } })
      .catch(() => { if (!cancelled && latest.current === key) { setTrip(null); setLoading(false); setError(true); } });
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { trip, loading, error };
}

function TripDetail({ trip, vehicle, currency, onSelectStop, canDrag, onResequence, pending, preview, phase }: { trip: Trip; vehicle: Vehicle; currency: string; onSelectStop: (seq: number) => void; canDrag?: boolean; onResequence?: (newOrderNos: string[]) => void; pending?: boolean; preview?: boolean; phase?: 'none' | 'pending' | 'loading' | 'preview' | 'error' }) {
  const t = useT();
  const why = routeRationale(trip);
  const [overSeq, setOverSeq] = useState<number | null>(null);
  const order = trip.stops.map((s) => s.orderNo);
  const orderSig = order.join(',');
  const listRef = useRef<HTMLOListElement>(null);
  // After a keyboard move the list re-renders; return focus to the moved stop's
  // same-direction arrow (or the opposite one if it is now an end) so repeated
  // presses keep nudging the same stop instead of dumping focus at the top.
  const focusAfterMove = useRef<{ orderNo: string; dir: -1 | 1 } | null>(null);
  useEffect(() => {
    const f = focusAfterMove.current;
    if (!f || !listRef.current) return;
    focusAfterMove.current = null;
    const same = listRef.current.querySelector<HTMLButtonElement>(`[data-move="${f.orderNo}:${f.dir}"]`);
    const opp = listRef.current.querySelector<HTMLButtonElement>(`[data-move="${f.orderNo}:${-f.dir}"]`);
    (same && !same.disabled ? same : opp)?.focus();
  }, [orderSig]);
  // Reorder this trip's stops by dropping one stop onto another (same drag used
  // for drag-to-reassign; here the drop target is a sibling stop, not a vehicle).
  const reorder = (draggedOrderNo: string, targetSeq: number): void => {
    const from = order.indexOf(draggedOrderNo);
    const target = trip.stops.find((s) => s.seq === targetSeq);
    if (from < 0 || !target) return;                 // dragged stop not in this trip (cross-vehicle drag)
    const to = order.indexOf(target.orderNo);
    if (to < 0 || from === to) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, draggedOrderNo);
    if (next.some((o, i) => o !== order[i])) onResequence?.(next);
  };
  // Keyboard (and click) reorder: swap a stop with its neighbour one step up/down.
  const moveStop = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    focusAfterMove.current = { orderNo: order[i]!, dir };
    onResequence?.(next);
  };
  const util = Math.max(ratio(trip.loadKg, vehicle.capacityKg), ratio(trip.loadPallets, vehicle.capacityPallets));
  const drive = trip.stops.reduce((n, s) => n + s.travelToSec, 0) + Math.max(0, trip.endSec - (trip.stops.at(-1)?.departureSec ?? trip.endSec));
  const wait = trip.stops.reduce((n, s) => n + s.waitSec, 0);
  // An order-dependent value (times, distance, cost) is stale once the stops are
  // reordered but not yet re-solved — show a dash so no wrong number is shown.
  const dash = '–';
  return (
    <div className="space-y-2">
      {(pending || preview) && (
        <div className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] ${phase === 'error' ? 'border-warning/50 bg-warning/5 text-warning' : 'border-primary/40 bg-primary/5 text-primary'}`}>
          {phase === 'loading'
            ? <><Loader2 className="h-3 w-3 animate-spin" /> {t('inspector.reorderCalculating')}</>
            : phase === 'error'
            ? <><AlertTriangle className="h-3 w-3" /> {t('inspector.reorderCalcFailed')}</>
            : <><ListOrdered className="h-3 w-3" /> {t(preview ? 'inspector.reorderPreview' : 'inspector.reorderPending')}</>}
        </div>
      )}
      <Field label={t('inspector.window')} value={pending ? dash : `${hhmm(trip.startSec)}–${hhmm(trip.endSec)}`} />
      <Field label={t('inspector.distance')} value={pending ? dash : km(trip.distanceKm)} />
      <Field label={t('inspector.load')} value={`${kg(trip.loadKg)} · ${plt(trip.loadPallets)} (${pct(util)})`} warn={!pending && util > 0.98} />
      <Field label={t('inspector.driveWait')} value={pending ? dash : `${t('inspector.minN', { n: Math.round(drive / 60) })} · ${t('inspector.minN', { n: Math.round(wait / 60) })}`} />
      {trip.costFt != null && <Field label={t('inspector.cost')} value={pending ? dash : money(trip.costFt, currency, true)} />}
      {!pending && trip.reloadSecAfter > 0 && <Field label={t('inspector.reloadAfter')} value={t('inspector.minN', { n: Math.round(trip.reloadSecAfter / 60) })} />}
      {/* why this sequence (describes the solved order; hidden while a reorder is pending) */}
      {!pending && (
        <div className="rounded border border-divider bg-muted/30 px-2 py-1.5 text-[11px]">
          <span className="text-muted-foreground">{t(why.windowDriven ? 'inspector.whyWindows' : 'inspector.whyDistance')}</span>
          {(why.tight > 0 || why.late > 0 || why.waits > 0) && (
            <span className="mt-0.5 flex flex-wrap gap-x-2">
              {why.late > 0 && <span className="text-warning">{t('inspector.whyLate', { n: why.late })}</span>}
              {why.tight > 0 && <span className="text-muted-foreground">{t('inspector.whyTight', { n: why.tight })}</span>}
              {why.waits > 0 && <span className="text-muted-foreground">{t('inspector.whyWaits', { n: why.waits })}</span>}
            </span>
          )}
        </div>
      )}
      <Separator />
      {canDrag && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <GripVertical className="h-3 w-3" /> {t(onResequence ? 'inspector.dragStop' : 'inspector.dragToReassign')}
        </div>
      )}
      <ol ref={listRef} className="space-y-0.5">
        {trip.stops.map((s, i) => {
          const reorderable = canDrag && !!onResequence;
          const name = s.customer ?? s.orderNo;
          return (
            <li key={s.seq}
              onDragOver={reorderable ? (e) => { if (isOrderDrag(e)) { e.preventDefault(); if (overSeq !== s.seq) setOverSeq(s.seq); } } : undefined}
              onDragLeave={reorderable ? () => setOverSeq((v) => (v === s.seq ? null : v)) : undefined}
              onDrop={reorderable ? (e) => { e.preventDefault(); setOverSeq(null); const o = readDraggedOrder(e); if (o) reorder(o, s.seq); } : undefined}
              className={`group flex items-stretch gap-0.5 ${overSeq === s.seq ? 'rounded ring-2 ring-primary/50' : ''}`}>
              <button type="button" onClick={() => onSelectStop(s.seq)}
                draggable={canDrag} onDragStart={canDrag ? (e) => setDraggedOrder(e, s.orderNo) : undefined}
                title={canDrag ? t(reorderable ? 'inspector.dragStop' : 'inspector.dragToReassign') : undefined}
                className={`flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded px-1 py-1 text-left text-xs hover:bg-accent ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''}`}>
                <span className="flex min-w-0 items-baseline truncate">
                  {canDrag && <GripVertical className="mr-0.5 h-3 w-3 shrink-0 self-center text-muted-foreground/60" />}
                  <span className="tnum text-muted-foreground">{i + 1}.</span>&nbsp;{name}
                  {!pending && <span className="tnum ml-1 text-[10px] text-muted-foreground">+{Math.round(s.travelToSec / 60)}m</span>}
                </span>
                <span className="tnum shrink-0 text-muted-foreground">{pending ? dash : <>{hhmm(s.arrivalSec)}{s.lateBySec > 0 && <span className="ml-1 text-warning">+{Math.round(s.lateBySec / 60)}m</span>}</>}</span>
              </button>
              {reorderable && (
                <span className="flex shrink-0 flex-col justify-center opacity-40 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <button type="button" data-move={`${s.orderNo}:-1`} disabled={i === 0} onClick={() => moveStop(i, -1)}
                    aria-label={t('inspector.moveEarlier', { name })} title={t('inspector.moveEarlier', { name })}
                    className="flex h-3.5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25">
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button type="button" data-move={`${s.orderNo}:1`} disabled={i === trip.stops.length - 1} onClick={() => moveStop(i, 1)}
                    aria-label={t('inspector.moveLater', { name })} title={t('inspector.moveLater', { name })}
                    className="flex h-3.5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25">
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* Trip view = TripDetail plus the live reorder-preview fetch. While a reorder is
 * pending we ask the backend to recompute the trip (it has the matrix + tariff);
 * until it answers we blank the order-dependent numbers (pending), then show the
 * recomputed ones (preview). The preview trip's stop `seq` is realigned to the
 * solved trip by order number so stop selection stays stable. */
function TripView({ planId, vehicle, trip, displayTrip, reorderPending, currency, canDrag, onSelectStop, onResequence }: {
  planId: string; vehicle: Vehicle; trip: Trip; displayTrip: Trip; reorderPending: boolean;
  currency: string; canDrag?: boolean; onSelectStop: (seq: number) => void; onResequence?: (newOrderNos: string[]) => void;
}) {
  const orderNos = displayTrip.stops.map((s) => s.orderNo);
  const { trip: previewTrip, loading, error } = useReorderPreview(planId, vehicle.id, trip, orderNos, reorderPending);
  const ready = reorderPending && !!previewTrip;
  let show = displayTrip;
  if (ready && previewTrip) {
    const seqByOrder = new Map(trip.stops.map((s) => [s.orderNo, s.seq]));
    show = { ...previewTrip, stops: previewTrip.stops.map((s) => ({ ...s, seq: seqByOrder.get(s.orderNo) ?? s.seq })) };
  }
  // Hint state: nothing while idle; recomputing / preview-ready / failed otherwise.
  const phase = !reorderPending ? 'none' : ready ? 'preview' : loading ? 'loading' : error ? 'error' : 'pending';
  return (
    <TripDetail trip={show} vehicle={vehicle} currency={currency} canDrag={canDrag}
      onSelectStop={onSelectStop} onResequence={onResequence}
      pending={reorderPending && !ready} preview={ready} phase={phase} />
  );
}

/* Per-stop manual assignment overrides: pin an order to its current vehicle,
 * move it to another, or forbid a vehicle. These accumulate on the scenario and
 * take effect on the next Replan (they do not solve immediately). */
function AssignmentSection({ plan, scenario, orderNo, currentVehicleId, onPin, onUnpin, onForbid, disabled }: {
  plan: Plan; scenario: Scenario; orderNo: string; currentVehicleId: number;
  onPin: (orderNo: string, vehicleId: number) => void;
  onUnpin: (orderNo: string) => void;
  onForbid: (orderNo: string, vehicleId: number) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const refOf = (id: number): string => plan.vehicles.find((v) => v.id === id)?.ref ?? `#${id}`;
  const pin = scenario.pins.find((p) => p.orderNo === orderNo);
  const forbidden = scenario.forbids.filter((f) => f.orderNo === orderNo).map((f) => f.vehicleId);
  const curRef = refOf(currentVehicleId);
  const others = plan.vehicles.filter((v) => v.id !== currentVehicleId);

  return (
    <div className="space-y-2 rounded-md border border-divider bg-muted/30 p-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('inspector.assignment')}</div>
      {pin ? (
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className="gap-1"><Pin className="h-3 w-3" /> {t('inspector.pinned', { ref: refOf(pin.vehicleId) })}</Badge>
          <button type="button" disabled={disabled} onClick={() => onUnpin(orderNo)} className="inline-flex items-center gap-1 rounded border border-divider px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-40">
            <PinOff className="h-3 w-3" /> {t('inspector.unpin')}
          </button>
        </div>
      ) : (
        <button type="button" disabled={disabled} onClick={() => onPin(orderNo, currentVehicleId)}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-divider px-2 py-1 text-xs hover:bg-accent disabled:opacity-40">
          <Pin className="h-3.5 w-3.5" /> {t('inspector.pinHere', { ref: curRef })}
        </button>
      )}

      <div className="flex items-center gap-1.5">
        <select defaultValue="" disabled={disabled} onChange={(e) => { const id = Number(e.target.value); if (id) { onPin(orderNo, id); e.target.value = ''; } }}
          className="h-7 min-w-0 flex-1 rounded border border-divider bg-card px-1.5 text-xs disabled:opacity-40">
          <option value="" disabled>{t('inspector.moveTo')}</option>
          {others.map((v) => <option key={v.id} value={v.id}>{v.ref}{v.vehicleClass ? ` · ${v.vehicleClass.replace(/_/g, ' ')}` : ''}</option>)}
        </select>
        <button type="button" disabled={disabled} onClick={() => onForbid(orderNo, currentVehicleId)} title={t('inspector.forbidHere', { ref: curRef })}
          className="inline-flex items-center gap-1 rounded border border-warning/40 px-1.5 py-1 text-[11px] text-warning hover:bg-warning/10 disabled:opacity-40">
          <Ban className="h-3 w-3" /> {t('inspector.forbidHere', { ref: curRef })}
        </button>
      </div>

      {forbidden.length > 0 && (
        <div className="text-[11px] text-muted-foreground">{t('inspector.forbiddenN', { refs: forbidden.map(refOf).join(', ') })}</div>
      )}
      <p className="text-[10px] text-muted-foreground">{t('inspector.overrideHint')}</p>
    </div>
  );
}

/* Staged per-vehicle constraint editor: capacity, shift window, and max trips/
 * distance/duration. Blank fields keep the dataset default; changes stage on the
 * scenario and apply on the next Replan. */
function ConstraintsEditor({ vehicle, override, onSet, onClear, disabled }: {
  vehicle: Vehicle; override?: import('@/types').VehicleOverride;
  onSet: (patch: VehicleConstraintPatch) => void; onClear: () => void; disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(Boolean(override));
  const timeToSec = (v: string): number | undefined => { if (!v) return undefined; const [h, m] = v.split(':').map(Number); return h * 3600 + m * 60; };
  const secToTime = (s?: number): string => (s == null ? '' : hhmm(s));
  const has = Boolean(override);

  return (
    <div className="rounded-md border border-divider">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/40">
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <SlidersHorizontal className="h-3.5 w-3.5" /> {t('inspector.constraints')}
        {has && <span className="ml-auto rounded bg-warning/15 px-1 text-[9px] text-warning">●</span>}
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2">
          <div className="grid grid-cols-2 gap-2">
            <Num label={t('inspector.capKg')} def={override?.capacityKg} ph={vehicle.capacityKg} onCommit={(v) => onSet({ capacityKg: v })} disabled={disabled} />
            <Num label={t('inspector.capPlt')} def={override?.capacityPallets} ph={vehicle.capacityPallets} onCommit={(v) => onSet({ capacityPallets: v })} disabled={disabled} />
            <Field2 label={t('inspector.shiftStart')}><input type="time" disabled={disabled} defaultValue={secToTime(override?.shiftEarlySec)} onChange={(e) => onSet({ shiftEarlySec: timeToSec(e.target.value) })} className="h-7 w-full rounded border border-divider bg-card px-1 text-xs disabled:opacity-40" /></Field2>
            <Field2 label={t('inspector.shiftEnd')}><input type="time" disabled={disabled} defaultValue={secToTime(override?.shiftLateSec)} onChange={(e) => onSet({ shiftLateSec: timeToSec(e.target.value) })} className="h-7 w-full rounded border border-divider bg-card px-1 text-xs disabled:opacity-40" /></Field2>
            <Num label={t('inspector.maxTrips')} def={override?.maxTrips} ph={vehicle.tripCount} onCommit={(v) => onSet({ maxTrips: v })} disabled={disabled} />
            <Num label={t('inspector.maxDist')} def={override?.maxDistanceKm} ph={Math.round(vehicle.distanceKm)} onCommit={(v) => onSet({ maxDistanceKm: v })} disabled={disabled} />
          </div>
          <p className="text-[10px] text-muted-foreground">{t('inspector.constraintsHint')}</p>
          {has && (
            <button type="button" onClick={onClear} className="flex w-full items-center justify-center gap-1.5 rounded border border-divider px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent">
              <X className="h-3 w-3" /> {t('inspector.clearConstraints')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Field2({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-0.5 block text-[10px] text-muted-foreground">{label}</span>{children}</label>;
}
function Num({ label, def, ph, onCommit, disabled }: { label: string; def?: number; ph: number; onCommit: (v: number | undefined) => void; disabled?: boolean }) {
  return (
    <Field2 label={label}>
      <input type="number" disabled={disabled} defaultValue={def ?? ''} placeholder={String(ph)}
        onBlur={(e) => { const n = Number(e.target.value); onCommit(e.target.value.trim() === '' || Number.isNaN(n) ? undefined : n); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="h-7 w-full rounded border border-divider bg-card px-1.5 text-xs disabled:opacity-40" />
    </Field2>
  );
}

function VehicleSummary({ vehicle, plan, onSelectTrip }: { vehicle: Vehicle; plan: Plan; onSelectTrip: (i: number) => void }) {
  const t = useT();
  const vcost = plan.cost?.perVehicle.find((c) => c.vehicleId === vehicle.id);
  return (
    <div className="space-y-2">
      <Field label={t('inspector.trips')} value={`${vehicle.tripCount}`} />
      <Field label={t('inspector.distance')} value={km(vehicle.distanceKm)} />
      <Field label={t('inspector.finish')} value={hhmm(vehicle.finishTimeSec)} />
      <Field label={t('inspector.capacity')} value={`${kg(vehicle.capacityKg)} · ${plt(vehicle.capacityPallets)}`} />
      {vcost && plan.cost && <Field label={t('inspector.cost')} value={money(vcost.totalCost, plan.cost.currency, true)} />}
      <Separator />
      <div className="space-y-1">
        {vehicle.trips.map((trip) => (
          <button key={trip.index} type="button" onClick={() => onSelectTrip(trip.index)} className="flex w-full items-center justify-between rounded border border-divider px-2 py-1 text-left text-xs hover:bg-accent">
            <span className="font-medium">{t('fleet.tripLabel', { n: trip.index + 1 })} · <span className="text-muted-foreground">{t('fleet.stopsN', { n: trip.stops.length })}</span></span>
            <span className="tnum text-muted-foreground">{hhmm(trip.startSec)}–{hhmm(trip.endSec)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ValidationRow({ plan, vehicle }: { plan: Plan; vehicle: Vehicle }) {
  const t = useT();
  const vios = (plan.provenance.validation.violations as ValidationViolation[]).filter((v) => v.vehicle_id === vehicle.id);
  const hard = vios.filter((v) => !v.soft);
  const soft = vios.filter((v) => v.soft);
  const tailMiss = soft.filter((v) => v.type === 'TAIL_LIFT').length;
  const sizeMiss = soft.filter((v) => v.type === 'VEHICLE_SIZE').length;
  if (vios.length === 0) return (
    <div className="flex items-center gap-1.5 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> {t('inspector.noViolations')}</div>
  );
  return (
    <div className="space-y-1">
      {hard.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs text-destructive"><AlertTriangle className="h-3.5 w-3.5" /> {violationDetail(v, t)}</div>
      ))}
      {(tailMiss > 0 || sizeMiss > 0) && (
        <div className="space-y-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700">
          <div className="font-medium">{t('constraint.advisories')}</div>
          {sizeMiss > 0 && <div className="flex items-center gap-1.5"><AlertTriangle className="h-3 w-3" /> {t('constraint.sizeAdvisory', { n: sizeMiss })}</div>}
          {tailMiss > 0 && <div className="flex items-center gap-1.5"><AlertTriangle className="h-3 w-3" /> {t('constraint.tailAdvisory', { n: tailMiss })}</div>}
        </div>
      )}
    </div>
  );
}

function LoadTab({ vehicle }: { vehicle: Vehicle }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <p className="rounded border border-divider bg-muted/40 p-2 text-[11px] text-muted-foreground">
        {t('inspector.loadNote')}
      </p>
      {vehicle.trips.map((trip) => (
        <div key={trip.index} className="space-y-1.5">
          <div className="text-xs font-semibold">{t('fleet.tripLabel', { n: trip.index + 1 })}</div>
          {[{ label: t('inspector.weight'), used: trip.loadKg, cap: vehicle.capacityKg, fmt: kg },
            { label: t('inspector.pallets'), used: trip.loadPallets, cap: vehicle.capacityPallets, fmt: plt }].map((d) => {
            const r = ratio(d.used, d.cap);
            return (
              <div key={d.label}>
                <div className="mb-0.5 flex items-baseline justify-between text-[11px]">
                  <span className="text-muted-foreground">{d.label}</span>
                  <span className="tnum">{d.fmt(d.used)} / {d.fmt(d.cap)} ({pct(r)})</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ width: `${r * 100}%`, backgroundColor: r > 0.98 ? '#d97706' : vehicle.color }} />
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function Inspector({ plan, scenario, selection, onSelect, onBack, onForward, canGoBack, canGoForward, onMarkUnavailable, onRestoreVehicle, onSetConstraint, onClearConstraint, solving, onPin, onUnpin, onForbid, onClearOverrides, onSetSequence, onClearSequence }: {
  plan: Plan; baseline: Plan; scenario: Scenario; selection: Selection; onSelect: (s: Selection) => void; onMarkUnavailable: (id: number) => void; solving: boolean;
  onBack: () => void; onForward: () => void; canGoBack: boolean; canGoForward: boolean;
  onRestoreVehicle: (id: number) => void;
  onSetConstraint: (vehicleId: number, patch: VehicleConstraintPatch) => void;
  onClearConstraint: (vehicleId: number) => void;
  onPin: (orderNo: string, vehicleId: number) => void;
  onUnpin: (orderNo: string) => void;
  onForbid: (orderNo: string, vehicleId: number) => void;
  onClearOverrides: () => void;
  onSetSequence?: (vehicleId: number, orderNos: string[], locked?: boolean) => void;
  onClearSequence?: (vehicleId: number) => void;
}) {
  const t = useT();
  const overrideCount = scenario.pins.length + scenario.forbids.length;
  const currency = plan.cost?.currency ?? 'HUF';
  const nav = { onBack, onForward, canGoBack, canGoForward };
  // Unassigned order context.
  if (selection?.kind === 'unassigned') {
    const u = plan.unassigned.find((x) => x.orderNo === selection.orderNo);
    const pin = u ? scenario.pins.find((p) => p.orderNo === u.orderNo) : undefined;
    const refOf = (id: number): string => plan.vehicles.find((v) => v.id === id)?.ref ?? `#${id}`;
    return (
      <Panel nav={nav}>
        {u ? (
          <div className="space-y-2 p-3">
            <div className="text-sm font-semibold">{u.customer ?? `Order ${u.orderNo}`}</div>
            <div className="tnum text-xs text-muted-foreground">#{u.orderNo}{u.city ? ` · ${u.city}` : ''}</div>
            <Separator />
            <Badge variant="warning">{t('inspector.unassignedBadge')}</Badge>
            <p className="text-xs text-muted-foreground">{u.reason ?? t('inspector.unassignedReason')}</p>
            {/* Assign by hand: pin this unassigned order to a chosen vehicle, applied on Replan. */}
            <div className="space-y-2 rounded-md border border-divider bg-muted/30 p-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('inspector.assignByHand')}</div>
              {pin ? (
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline" className="gap-1"><Pin className="h-3 w-3" /> {t('inspector.pinned', { ref: refOf(pin.vehicleId) })}</Badge>
                  <button type="button" onClick={() => onUnpin(u.orderNo)} className="inline-flex items-center gap-1 rounded border border-divider px-1.5 py-0.5 text-[11px] hover:bg-accent"><PinOff className="h-3 w-3" /> {t('inspector.unpin')}</button>
                </div>
              ) : (
                <select defaultValue="" disabled={solving} onChange={(e) => { const id = Number(e.target.value); if (id) onPin(u.orderNo, id); }}
                  className="h-7 w-full rounded border border-divider bg-card px-1.5 text-xs disabled:opacity-40">
                  <option value="" disabled>{t('inspector.assignTo')}</option>
                  {plan.vehicles.map((v) => <option key={v.id} value={v.id}>{v.ref}{v.vehicleClass ? ` · ${v.vehicleClass.replace(/_/g, ' ')}` : ''}</option>)}
                </select>
              )}
              <p className="text-[10px] text-muted-foreground">{t('inspector.overrideHint')}</p>
            </div>
          </div>
        ) : <Empty planId={plan.id} />}
      </Panel>
    );
  }

  const vehicleId = selection ? selection.vehicleId : null;
  const vehicle = vehicleId != null ? plan.vehicles.find((v) => v.id === vehicleId) : undefined;
  if (!vehicle) return <Panel nav={nav}><Empty planId={plan.id} /></Panel>;

  const trip = selection && (selection.kind === 'trip' || selection.kind === 'stop')
    ? vehicle.trips.find((t) => t.index === selection.tripIndex) : undefined;
  const stop = selection?.kind === 'stop' && trip ? trip.stops.find((s) => s.seq === selection.seq) : undefined;
  // Reflect a staged reorder/lock in the stop list (the plan only updates on Replan).
  const stagedSeq = scenario.sequences.find((q) => q.vehicleId === vehicle.id);
  const displayTrip = trip && stagedSeq ? reorderTripStops(trip, stagedSeq.orderNos) : trip;
  // This trip is "pending" if a reorder (not a lock) changed its displayed order.
  const reorderPending = !!displayTrip && !!trip && !stagedSeq?.locked
    && displayTrip.stops.some((s, i) => s.orderNo !== trip.stops[i]?.orderNo);

  return (
    <Panel nav={nav}>
      <Tabs defaultValue="details" className="flex min-h-0 flex-1 flex-col">
        <div className="px-3 pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: vehicle.color }} />
            <button type="button" onClick={() => onSelect({ kind: 'vehicle', vehicleId: vehicle.id })}
              className={`font-semibold ${trip ? 'hover:underline' : ''}`} title={trip ? t('inspector.backToVehicle') : undefined}>{vehicle.ref}</button>
            {vehicle.vehicleClass && <Badge variant="outline">{vehicle.vehicleClass.replace(/_/g, ' ')}</Badge>}
            {vehicle.tonnage != null && <Badge variant="outline" className="text-[10px]">{t('constraint.tonnage', { n: vehicle.tonnage })}</Badge>}
            {vehicle.hasTailLift && <Badge variant="outline" className="text-[10px]">{t('constraint.tailLift')}</Badge>}
            {vehicle.isSubcontractor && <Badge variant="warning">{t('inspector.subcontractor')}</Badge>}
            {stop && trip ? (
              <button type="button" onClick={() => onSelect({ kind: 'trip', vehicleId: vehicle.id, tripIndex: trip.index })}
                className="tnum ml-auto text-xs text-muted-foreground hover:underline">{t('inspector.tripN', { n: trip.index + 1 })} · {t('inspector.stopN', { n: stop.seq })}</button>
            ) : trip ? <span className="tnum ml-auto text-xs text-muted-foreground">{t('inspector.tripN', { n: trip.index + 1 })}</span> : null}
          </div>
          <TabsList className="w-full">
            <TabsTrigger value="details" className="flex-1">{t('inspector.tabDetails')}</TabsTrigger>
            <TabsTrigger value="load" className="flex-1">{t('inspector.tabLoad')}</TabsTrigger>
          </TabsList>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-3">
            <TabsContent value="details" className="mt-0 space-y-3">
              {stop ? <StopDetail stop={stop} vehicle={vehicle} />
                : trip && displayTrip ? <TripView planId={plan.id} trip={trip} displayTrip={displayTrip} reorderPending={reorderPending} vehicle={vehicle} currency={currency} canDrag={!solving}
                    onSelectStop={(seq) => onSelect({ kind: 'stop', vehicleId: vehicle.id, tripIndex: trip.index, seq })}
                    onResequence={onSetSequence ? (newOrderNos) => {
                      // the vehicle's full manual order = each trip's stops (in their
                      // displayed/staged order), with THIS trip set to the new order
                      const full = vehicle.trips.flatMap((tr) => (tr.index === trip.index
                        ? newOrderNos
                        : (stagedSeq ? reorderTripStops(tr, stagedSeq.orderNos) : tr).stops.map((s) => s.orderNo)));
                      onSetSequence(vehicle.id, full);
                    } : undefined} />
                  : <VehicleSummary vehicle={vehicle} plan={plan} onSelectTrip={(i) => onSelect({ kind: 'trip', vehicleId: vehicle.id, tripIndex: i })} />}
              {stop && (
                <AssignmentSection plan={plan} scenario={scenario} orderNo={stop.orderNo} currentVehicleId={vehicle.id}
                  onPin={onPin} onUnpin={onUnpin} onForbid={onForbid} disabled={solving} />
              )}
              <Separator />
              <ValidationRow plan={plan} vehicle={vehicle} />
              {!stop && !trip && (
                <ConstraintsEditor vehicle={vehicle}
                  override={scenario.vehicleOverrides.find((o) => o.vehicleId === vehicle.id)}
                  onSet={(patch) => onSetConstraint(vehicle.id, patch)} onClear={() => onClearConstraint(vehicle.id)} disabled={solving} />
              )}
              {/* Lock-and-resolve: freeze this vehicle's route; the rest re-solves around it. */}
              {!stop && !trip && onSetSequence && onClearSequence && vehicle.trips.some((tr) => tr.stops.length > 0) && (
                scenario.sequences.some((q) => q.vehicleId === vehicle.id && q.locked) ? (
                  <button type="button" disabled={solving} onClick={() => onClearSequence(vehicle.id)}
                    className="flex w-full items-center justify-center gap-1.5 rounded border border-primary/50 bg-primary/5 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-40">
                    <Lock className="h-3 w-3" /> {t('inspector.unlockRoute')}
                  </button>
                ) : (
                  <button type="button" disabled={solving} title={t('inspector.lockRouteHint')}
                    onClick={() => onSetSequence(vehicle.id, vehicle.trips.flatMap((tr) => tr.stops.map((s) => s.orderNo)), true)}
                    className="flex w-full items-center justify-center gap-1.5 rounded border border-divider px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-40">
                    <LockOpen className="h-3 w-3" /> {t('inspector.lockRoute')}
                  </button>
                )
              )}
              {overrideCount > 0 && (
                <button type="button" onClick={onClearOverrides}
                  className="flex w-full items-center justify-center gap-1.5 rounded border border-divider px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent">
                  <X className="h-3 w-3" /> {t('inspector.clearOverrides')} ({overrideCount})
                </button>
              )}
              {scenario.removedVehicleIds.includes(vehicle.id) ? (
                <button type="button" disabled={solving} onClick={() => onRestoreVehicle(vehicle.id)}
                  className="flex w-full items-center justify-center gap-1.5 rounded border border-divider px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-40">
                  <RotateCcw className="h-3.5 w-3.5" /> {t('fleet.restore')}
                </button>
              ) : (
                <button type="button" disabled={solving} onClick={() => onMarkUnavailable(vehicle.id)}
                  className="flex w-full items-center justify-center gap-1.5 rounded border border-warning/40 px-2 py-1.5 text-xs font-medium text-warning hover:bg-warning/10 disabled:opacity-40">
                  <Ban className="h-3.5 w-3.5" /> {t('inspector.markUnavailable', { ref: vehicle.ref })}
                </button>
              )}
            </TabsContent>
            <TabsContent value="load" className="mt-0">
              <LoadTab vehicle={vehicle} />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </Panel>
  );
}

function Panel({ children, nav }: { children: React.ReactNode; nav: { onBack: () => void; onForward: () => void; canGoBack: boolean; canGoForward: boolean } }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <button type="button" onClick={nav.onBack} disabled={!nav.canGoBack} aria-label={t('inspector.back')} title={t('inspector.back')}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button type="button" onClick={nav.onForward} disabled={!nav.canGoForward} aria-label={t('inspector.forward')} title={t('inspector.forward')}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent">
          <ArrowRight className="h-4 w-4" />
        </button>
        <h2 className="ml-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('inspector.title')}</h2>
      </div>
      <Separator />
      {children}
    </div>
  );
}
function Empty({ planId }: { planId: string }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <NarrationPanel planId={planId} />
      <p className="px-3 text-center text-sm text-muted-foreground">{t('inspector.empty')}</p>
    </div>
  );
}
