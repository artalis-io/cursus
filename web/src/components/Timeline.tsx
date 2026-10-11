import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Square } from 'lucide-react';
import { hhmm } from '@/lib/format';
import { useT } from '@/i18n';
import type { Plan, Selection, Vehicle } from '@/types';

/* Vehicle timeline. With a vehicle selected: that vehicle's full working day -
 * explicit trips, per-stop travel/service/wait segments, reload periods and
 * depot returns, on a common hourly scale. With nothing selected: a compact
 * fleet Gantt (one row per vehicle), clickable to select. Custom SVG. */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const GRID = 'hsl(42 14% 82%)';
const AXIS_TXT = 'hsl(40 8% 42%)';

/* Activate a focusable SVG element (role=button) from the keyboard. */
function onKeyActivate(e: React.KeyboardEvent, fn: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
}

function hourTicks(lo: number, hi: number): number[] {
  const t: number[] = [];
  for (let s = Math.floor(lo / 3600) * 3600; s <= Math.ceil(hi / 3600) * 3600; s += 3600) t.push(s);
  return t;
}

function Header({ title, hint, controls }: { title: string; hint: string; controls?: React.ReactNode }) {
  const t = useT();
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('timeline.title')}</h2>
      <span className="text-[11px] text-foreground/70">{title}</span>
      <span className="hidden text-[11px] text-muted-foreground sm:inline">· {hint}</span>
      <div className="ml-auto">{controls}</div>
    </div>
  );
}

function VehicleTimeline({ vehicle, selection, onSelect, clockSec, onSeek }: { vehicle: Vehicle; selection: Selection; onSelect: (s: Selection) => void; clockSec: number | null; onSeek: (sec: number) => void }) {
  const t = useT();
  const translate = t; // `t` is shadowed by the trip loop variable below; alias for i18n inside it
  const [ref, width] = useWidth<HTMLDivElement>();
  const padL = 12, padR = 16, laneY = 46, laneH = 22;
  const { lo, hi } = useMemo(() => {
    let a = Infinity, b = -Infinity;
    for (const t of vehicle.trips) { a = Math.min(a, t.startSec); b = Math.max(b, t.endSec); }
    if (!Number.isFinite(a)) { a = 18000; b = 64800; }
    return { lo: Math.floor(a / 3600) * 3600, hi: Math.ceil(b / 3600) * 3600 };
  }, [vehicle]);
  const span = Math.max(1, hi - lo);
  const plotW = Math.max(50, width - padL - padR);
  const xOf = (s: number) => padL + ((s - lo) / span) * plotW;
  const secOf = (clientX: number, rect: DOMRect) => lo + ((clientX - rect.left - padL) / plotW) * span;
  const H = 78;
  const selStopSeq = selection?.kind === 'stop' && selection.vehicleId === vehicle.id ? selection.seq : null;
  const selTrip = selection && (selection.kind === 'trip' || selection.kind === 'stop') && selection.vehicleId === vehicle.id ? selection.tripIndex : null;
  const cursorX = clockSec != null && clockSec >= lo && clockSec <= hi ? xOf(clockSec) : null;

  return (
    <div ref={ref} className="h-full w-full px-2">
      <svg width={width} height={H} role="group" aria-label={t('timeline.workingDay', { ref: vehicle.ref })} style={{ cursor: 'crosshair' }}
        onClick={(e) => onSeek(secOf(e.clientX, e.currentTarget.getBoundingClientRect()))}>
        {hourTicks(lo, hi).map((s) => (
          <g key={s}>
            <line x1={xOf(s)} x2={xOf(s)} y1={16} y2={H - 6} stroke={GRID} strokeWidth={1} />
            <text x={xOf(s)} y={11} textAnchor="middle" fontSize={10} fill={AXIS_TXT} style={{ fontVariantNumeric: 'tabular-nums' }}>{hhmm(s)}</text>
          </g>
        ))}
        {/* reload periods between consecutive trips */}
        {vehicle.trips.slice(0, -1).map((t, i) => {
          const next = vehicle.trips[i + 1]!;
          const x = xOf(t.endSec), w = Math.max(1, xOf(next.startSec) - x);
          return <rect key={`r${t.index}`} x={x} y={laneY} width={w} height={laneH} fill="url(#reload)" stroke={GRID} />;
        })}
        {/* trips */}
        {vehicle.trips.map((t) => {
          const dim = selTrip != null && selTrip !== t.index;
          const op = dim ? 0.25 : 1;
          const selectTrip = () => onSelect({ kind: 'trip', vehicleId: vehicle.id, tripIndex: t.index });
          return (
            <g key={t.index} opacity={op} role="button" tabIndex={0}
              aria-label={translate('timeline.tripAria', { n: t.index + 1, from: hhmm(t.startSec), to: hhmm(t.endSec) })}
              onClick={(e) => { e.stopPropagation(); selectTrip(); }}
              onKeyDown={(e) => onKeyActivate(e, selectTrip)} style={{ cursor: 'pointer' }}>
              {/* travel baseline across the whole trip */}
              <rect x={xOf(t.startSec)} y={laneY + laneH / 2 - 2} width={Math.max(1, xOf(t.endSec) - xOf(t.startSec))} height={4} rx={2} fill={vehicle.color} fillOpacity={0.28} />
              {/* depot start/end markers */}
              <rect x={xOf(t.startSec) - 1.5} y={laneY} width={3} height={laneH} fill="#223a2e" />
              <rect x={xOf(t.endSec) - 1.5} y={laneY} width={3} height={laneH} fill="#223a2e" />
              {t.stops.map((s) => {
                const sx = xOf(s.serviceStartSec);
                const sw = Math.max(2, xOf(s.departureSec) - sx);
                const ww = Math.max(0, xOf(s.serviceStartSec) - xOf(s.arrivalSec));
                const isSel = selStopSeq === s.seq;
                const isActive = clockSec != null && clockSec >= s.arrivalSec && clockSec <= s.departureSec;
                return (
                  <g key={s.seq} onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'stop', vehicleId: vehicle.id, tripIndex: t.index, seq: s.seq }); }} style={{ cursor: 'pointer' }}>
                    {ww > 0.5 && <rect x={xOf(s.arrivalSec)} y={laneY + 3} width={ww} height={laneH - 6} fill="#d97706" fillOpacity={0.6} />}
                    <rect x={sx} y={laneY} width={sw} height={laneH} rx={2} fill={vehicle.color} stroke={isSel || isActive ? '#111' : 'none'} strokeWidth={isSel || isActive ? 1.5 : 0} />
                    {isActive && <rect x={sx - 1} y={laneY - 3} width={sw + 2} height={laneH + 6} rx={3} fill="none" stroke="#111" strokeWidth={1} strokeDasharray="2 2" />}
                  </g>
                );
              })}
            </g>
          );
        })}
        <defs>
          <pattern id="reload" width={6} height={6} patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width={6} height={6} fill="hsl(42 14% 88%)" />
            <line x1={0} y1={0} x2={0} y2={6} stroke="hsl(40 8% 60%)" strokeWidth={1} />
          </pattern>
        </defs>
        {cursorX != null && (
          <g pointerEvents="none">
            <line x1={cursorX} x2={cursorX} y1={14} y2={H - 4} stroke="#111" strokeWidth={1.5} />
            <polygon points={`${cursorX - 4},14 ${cursorX + 4},14 ${cursorX},20`} fill="#111" />
          </g>
        )}
      </svg>
      <div className="flex items-center gap-3 px-1 text-[10px] text-muted-foreground">
        <Legend color={vehicle.color} label={t('timeline.service')} />
        <Legend color="#d97706" label={t('timeline.wait')} />
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3" style={{ background: 'repeating-linear-gradient(45deg,#e8e3d6,#e8e3d6 2px,#aaa 3px)' }} /> {t('timeline.reload')}</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-[3px] bg-[#223a2e]" /> {t('timeline.depot')}</span>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: color }} /> {label}</span>;
}

function FleetOverview({ plan, onSelect, clockSec, onSeek }: { plan: Plan; onSelect: (s: Selection) => void; clockSec: number | null; onSeek: (sec: number) => void }) {
  const t = useT();
  const [ref, width] = useWidth<HTMLDivElement>();
  const rowH = 16, labelW = 56, padR = 12, axisH = 16;
  const { lo, hi } = useMemo(() => {
    let a = Infinity, b = -Infinity;
    for (const v of plan.vehicles) for (const t of v.trips) { a = Math.min(a, t.startSec); b = Math.max(b, t.endSec); }
    if (!Number.isFinite(a)) { a = 18000; b = 72000; }
    return { lo: Math.floor(a / 3600) * 3600, hi: Math.ceil(b / 3600) * 3600 };
  }, [plan]);
  const span = Math.max(1, hi - lo);
  const plotW = Math.max(50, width - labelW - padR);
  const xOf = (s: number) => labelW + ((s - lo) / span) * plotW;
  const secOf = (clientX: number, rect: DOMRect) => lo + ((clientX - rect.left - labelW) / plotW) * span;
  const H = axisH + plan.vehicles.length * rowH + 6;
  const cursorX = clockSec != null && clockSec >= lo && clockSec <= hi ? xOf(clockSec) : null;

  return (
    <div ref={ref} className="h-full w-full overflow-y-auto px-2">
      <svg width={width} height={H} role="group" aria-label={t('timeline.fleetOverview')} style={{ cursor: 'crosshair' }}
        onClick={(e) => onSeek(secOf(e.clientX, e.currentTarget.getBoundingClientRect()))}>
        {hourTicks(lo, hi).map((s) => (
          <g key={s}>
            <line x1={xOf(s)} x2={xOf(s)} y1={axisH} y2={H - 4} stroke={GRID} strokeWidth={1} />
            <text x={xOf(s)} y={11} textAnchor="middle" fontSize={9} fill={AXIS_TXT} style={{ fontVariantNumeric: 'tabular-nums' }}>{hhmm(s)}</text>
          </g>
        ))}
        {plan.vehicles.map((v, i) => {
          const y = axisH + i * rowH + 2;
          const selectVeh = () => onSelect({ kind: 'vehicle', vehicleId: v.id });
          return (
            <g key={v.id} role="button" tabIndex={0}
              aria-label={t('timeline.vehicleAria', { ref: v.ref, n: v.tripCount, t: hhmm(v.finishTimeSec) })}
              onClick={(e) => { e.stopPropagation(); selectVeh(); }}
              onKeyDown={(e) => onKeyActivate(e, selectVeh)} style={{ cursor: 'pointer' }}>
              <text x={4} y={y + rowH - 6} fontSize={10} fill="hsl(40 10% 18%)" style={{ fontVariantNumeric: 'tabular-nums' }}>{v.ref}</text>
              {v.trips.map((t) => {
                const active = clockSec != null && clockSec >= t.startSec && clockSec <= t.endSec;
                return <rect key={t.index} x={xOf(t.startSec)} y={y} width={Math.max(2, xOf(t.endSec) - xOf(t.startSec))} height={rowH - 5} rx={2} fill={v.color} fillOpacity={0.85} stroke={active ? '#111' : 'none'} strokeWidth={active ? 1 : 0} />;
              })}
            </g>
          );
        })}
        {cursorX != null && <line x1={cursorX} x2={cursorX} y1={axisH - 2} y2={H - 4} stroke="#111" strokeWidth={1.5} pointerEvents="none" />}
      </svg>
    </div>
  );
}

export function Timeline({ plan, selection, onSelect, clockSec, playing, speed, dayRange, onTogglePlay, onSeek, onStop, onSpeed }: {
  plan: Plan; selection: Selection; onSelect: (s: Selection) => void;
  clockSec: number | null; playing: boolean; speed: number; dayRange: { lo: number; hi: number };
  onTogglePlay: () => void; onSeek: (sec: number) => void; onStop: () => void; onSpeed: (n: number) => void;
}) {
  const t = useT();
  const vehId = selection && selection.kind !== 'unassigned' ? selection.vehicleId : null;
  const vehicle = vehId != null ? plan.vehicles.find((v) => v.id === vehId) : null;
  return (
    <div className="flex h-full flex-col bg-card" role="region" aria-label={t('timeline.title')}>
      <Header
        title={vehicle ? t('timeline.workingDay', { ref: vehicle.ref }) : t('timeline.fleetOverview')}
        hint={vehicle ? t('timeline.vehHint', { n: vehicle.tripCount, t: hhmm(vehicle.finishTimeSec) }) : t('timeline.selectHint')}
        controls={<PlaybackControls clockSec={clockSec} playing={playing} speed={speed} onTogglePlay={onTogglePlay} onStop={onStop} onSpeed={onSpeed} onSeek={onSeek} dayRange={dayRange} />}
      />
      <div className="min-h-0 flex-1 overflow-hidden pb-1">
        {vehicle ? <VehicleTimeline vehicle={vehicle} selection={selection} onSelect={onSelect} clockSec={clockSec} onSeek={onSeek} /> : <FleetOverview plan={plan} onSelect={onSelect} clockSec={clockSec} onSeek={onSeek} />}
      </div>
    </div>
  );
}

const SPEEDS = [120, 360, 900, 1800];
function PlaybackControls({ clockSec, playing, speed, onTogglePlay, onStop, onSpeed, onSeek, dayRange }: {
  clockSec: number | null; playing: boolean; speed: number;
  onTogglePlay: () => void; onStop: () => void; onSpeed: (n: number) => void; onSeek: (sec: number) => void; dayRange: { lo: number; hi: number };
}) {
  const t = useT();
  const active = clockSec != null;
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={onTogglePlay} aria-label={playing ? t('play.pause') : t('play.play')}
        className="flex h-6 w-6 items-center justify-center rounded border border-divider hover:bg-accent">
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </button>
      <button type="button" onClick={onStop} disabled={!active} aria-label={t('play.stop')}
        className="flex h-6 w-6 items-center justify-center rounded border border-divider hover:bg-accent disabled:opacity-40"><Square className="h-3 w-3" /></button>
      {/* Always-available scrubber so keyboard users can seek without first pressing play. */}
      <input type="range" min={dayRange.lo} max={dayRange.hi} step={60} value={clockSec ?? dayRange.lo}
        onChange={(e) => onSeek(Number(e.target.value))} className="h-1 w-28 accent-[var(--primary)]" aria-label={t('play.seek')} />
      <span className={`tnum w-10 text-[11px] ${active ? 'text-foreground' : 'text-muted-foreground'}`}>{hhmm(clockSec ?? dayRange.lo)}</span>
      <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} className="h-6 rounded border border-divider bg-card px-1 text-[10px]" aria-label={t('play.speed')}>
        {SPEEDS.map((s) => <option key={s} value={s}>{s / 60}×</option>)}
      </select>
    </div>
  );
}
