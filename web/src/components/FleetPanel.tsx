import { useEffect, useState } from 'react';
import { ChevronRight, Search, Ban, RotateCcw, GripVertical } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { hhmm, km, ratio, pct } from '@/lib/format';
import { setDraggedOrder, isOrderDrag, readDraggedOrder } from '@/lib/dnd';
import { useT } from '@/i18n';
import type { Plan, Scenario, Vehicle, Selection } from '@/types';

function FilterChip({ active, onClick, label, warn }: { active: boolean; onClick: () => void; label: string; warn?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${active ? (warn ? 'border-warning bg-warning/15 text-warning' : 'border-primary bg-primary/10 text-primary') : 'border-divider text-muted-foreground hover:bg-accent'}`}>
      {label}
    </button>
  );
}

function CapacityBar({ label, used, cap, color }: { label: string; used: number; cap: number; color: string }) {
  const r = ratio(used, cap);
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 text-[10px] uppercase text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${r * 100}%`, backgroundColor: color }} />
      </div>
      <span className="tnum w-9 text-right text-[10px] text-muted-foreground">{pct(r)}</span>
    </div>
  );
}

function VehicleCard({
  vehicle, selection, onSelect, onMarkUnavailable, onRestore, removed, expanded, onToggle, solving, onAssignOrder,
}: {
  vehicle: Vehicle; selection: Selection; onSelect: (s: Selection) => void;
  onMarkUnavailable: (id: number) => void; onRestore: (id: number) => void; removed: boolean;
  expanded: boolean; onToggle: () => void; solving: boolean;
  onAssignOrder?: (orderNo: string, vehicleId: number) => void;
}) {
  const t = useT();
  const selThisVeh = selection && selection.kind !== 'unassigned' && selection.vehicleId === vehicle.id;
  const selTrip = selection && (selection.kind === 'trip' || selection.kind === 'stop') ? selection.tripIndex : null;
  // Drop target: dragging an order here pins it to this vehicle (applied on Replan).
  const canDrop = !!onAssignOrder && !solving && !removed;
  const [dragOver, setDragOver] = useState(false);
  const dropProps = canDrop ? {
    onDragOver: (e: React.DragEvent) => { if (isOrderDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!dragOver) setDragOver(true); } },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); const o = readDraggedOrder(e); if (o) onAssignOrder!(o, vehicle.id); },
  } : {};
  return (
    <div {...dropProps}
      className={`rounded-md border bg-card transition-colors ${dragOver ? 'border-primary ring-2 ring-primary/40' : removed ? 'border-warning/40 opacity-60' : selThisVeh ? 'border-ring ring-1 ring-ring' : 'border-divider hover:bg-accent/50'}`}>
      <div className="flex cursor-pointer items-center gap-2 p-2.5" onClick={() => onSelect({ kind: 'vehicle', vehicleId: vehicle.id })}>
        <button type="button" aria-label={expanded ? 'Collapse trips' : 'Expand trips'} onClick={(e) => { e.stopPropagation(); onToggle(); }} className="-ml-1 text-muted-foreground hover:text-foreground">
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
        <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: vehicle.color }} />
        <span className={`font-semibold ${removed ? 'line-through' : ''}`}>{vehicle.ref}</span>
        {removed && <Badge variant="warning" className="px-1 py-0 text-[9px]">{t('fleet.staged')}</Badge>}
        <span className="truncate text-[11px] text-muted-foreground">{(vehicle.vehicleClass ?? '').replace(/_/g, ' ')}</span>
        <span className="tnum ml-auto text-[11px] text-muted-foreground">{vehicle.tripCount === 1 ? t('fleet.tripOne', { n: vehicle.tripCount }) : t('fleet.trips', { n: vehicle.tripCount })}</span>
      </div>
      <div className="px-2.5 pb-2.5">
        <div className="space-y-1">
          <CapacityBar label="kg" used={vehicle.peakKg} cap={vehicle.capacityKg} color={vehicle.color} />
          <CapacityBar label="plt" used={vehicle.peakPallets} cap={vehicle.capacityPallets} color={vehicle.color} />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="tnum">{km(vehicle.distanceKm)}</span>
          <span className="tnum">{t('fleet.finish', { t: hhmm(vehicle.finishTimeSec) })}</span>
        </div>
        {expanded && (
          <div className="mt-2 space-y-1 border-t border-divider pt-2">
            {vehicle.trips.map((trip) => {
              const sel = selTrip === trip.index;
              return (
                <button key={trip.index} type="button"
                  onClick={() => onSelect({ kind: 'trip', vehicleId: vehicle.id, tripIndex: trip.index })}
                  className={`flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-[11px] hover:bg-accent ${sel ? 'bg-accent' : ''}`}>
                  <span>{t('fleet.tripLabel', { n: trip.index + 1 })} · <span className="tnum text-muted-foreground">{t('fleet.stopsN', { n: trip.stops.length })}</span></span>
                  <span className="tnum text-muted-foreground">{hhmm(trip.startSec)}–{hhmm(trip.endSec)}</span>
                </button>
              );
            })}
            {removed ? (
              <button type="button" disabled={solving} onClick={() => onRestore(vehicle.id)}
                className="mt-1 flex w-full items-center justify-center gap-1.5 rounded border border-divider px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent disabled:opacity-40">
                <RotateCcw className="h-3 w-3" /> {t('fleet.restore')}
              </button>
            ) : (
              <button type="button" disabled={solving}
                onClick={() => onMarkUnavailable(vehicle.id)}
                className="mt-1 flex w-full items-center justify-center gap-1.5 rounded border border-warning/40 px-2 py-1 text-[11px] font-medium text-warning hover:bg-warning/10 disabled:opacity-40">
                <Ban className="h-3 w-3" /> {t('fleet.markUnavailable')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* Left fleet panel: search, vehicle cards (expandable to trips + mark-unavailable),
 * and a collapsible unassigned-orders section. Selection is lifted to App. */
export function FleetPanel({
  plan, scenario, selection, onSelect, onMarkUnavailable, onRestoreVehicle, solving, onFilterChange, onAssignOrder, onBulkAssign,
}: {
  plan: Plan; scenario: Scenario; selection: Selection; onSelect: (s: Selection) => void;
  onMarkUnavailable: (id: number) => void; onRestoreVehicle: (id: number) => void; solving: boolean;
  onFilterChange?: (visibleVehicleIds: number[] | null) => void;
  onAssignOrder?: (orderNo: string, vehicleId: number) => void;
  onBulkAssign?: (orderNos: string[], vehicleId: number) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  // Bulk-select of unassigned orders -> assign many to one vehicle at once.
  const [bulkSel, setBulkSel] = useState<Set<string>>(new Set());
  const [bulkVeh, setBulkVeh] = useState('');
  useEffect(() => { setBulkSel(new Set()); setBulkVeh(''); }, [plan.id]);
  const toggleBulk = (orderNo: string) => setBulkSel((prev) => { const n = new Set(prev); if (n.has(orderNo)) n.delete(orderNo); else n.add(orderNo); return n; });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [unassignedOpen, setUnassignedOpen] = useState(plan.unassigned.length > 0);
  const [onlyTailLift, setOnlyTailLift] = useState(false);
  const [onlyAdvisories, setOnlyAdvisories] = useState(false);

  const advisoryIds = new Set<number>();
  for (const v of plan.provenance.validation.violations as { soft?: boolean; vehicle_id?: number }[]) if (v.soft && v.vehicle_id != null) advisoryIds.add(v.vehicle_id);

  const q = query.trim().toLowerCase();
  const matches = (v: Vehicle): boolean => {
    if (onlyTailLift && !v.hasTailLift) return false;
    if (onlyAdvisories && !advisoryIds.has(v.id)) return false;
    if (!q) return true;
    if (v.ref.toLowerCase().includes(q) || (v.vehicleClass ?? '').toLowerCase().includes(q)) return true;
    return v.trips.some((t) => t.stops.some((s) =>
      (s.customer ?? '').toLowerCase().includes(q) || s.orderNo.toLowerCase().includes(q) || (s.city ?? '').toLowerCase().includes(q)));
  };
  const vehicles = plan.vehicles.filter(matches);

  // Report the visible vehicle set to the map so it filters routes/stops to
  // match the list. null = no filter active (show all). Keyed on the id list so
  // we only notify when the visible set actually changes.
  const filterActive = onlyTailLift || onlyAdvisories || q !== '';
  const visibleIds = filterActive ? vehicles.map((v) => v.id) : null;
  const visKey = visibleIds ? visibleIds.join(',') : 'all';
  useEffect(() => {
    onFilterChange?.(visibleIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visKey]);
  // Clear the map filter when the panel unmounts (e.g. the fleet column is collapsed).
  useEffect(() => () => onFilterChange?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const selUnassigned = selection?.kind === 'unassigned' ? selection.orderNo : null;

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="shrink-0 p-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('fleet.title')} · {plan.vehicles.length}</h2>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('fleet.search')} className="h-8 pl-8" />
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <FilterChip active={onlyTailLift} onClick={() => setOnlyTailLift((o) => !o)} label={t('fleet.filterTailLift')} />
          {advisoryIds.size > 0 && <FilterChip active={onlyAdvisories} onClick={() => setOnlyAdvisories((o) => !o)} label={`${t('fleet.filterAdvisories')} · ${advisoryIds.size}`} warn />}
        </div>
      </div>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {vehicles.map((v) => (
            <VehicleCard key={v.id} vehicle={v} selection={selection} onSelect={onSelect}
              onMarkUnavailable={onMarkUnavailable} onRestore={onRestoreVehicle} removed={scenario.removedVehicleIds.includes(v.id)} solving={solving}
              expanded={expanded.has(v.id)} onAssignOrder={onAssignOrder}
              onToggle={() => setExpanded((prev) => { const n = new Set(prev); if (n.has(v.id)) n.delete(v.id); else n.add(v.id); return n; })} />
          ))}
          {vehicles.length === 0 && <p className="px-1 py-6 text-center text-xs text-muted-foreground">{t('fleet.noMatch')}</p>}
        </div>
      </ScrollArea>
      <Separator />
      <div className="shrink-0">
        <button type="button" onClick={() => setUnassignedOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/40">
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${unassignedOpen ? 'rotate-90' : ''}`} />
          {t('fleet.unassigned')}
          <span className={`tnum ml-auto rounded px-1.5 ${plan.unassigned.length ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground'}`}>{plan.unassigned.length}</span>
        </button>
        {unassignedOpen && (
          <div className="px-2 pb-2">
            {onBulkAssign && plan.unassigned.length > 0 && (
              <div className="flex items-center gap-2 py-1 text-[10px] text-muted-foreground">
                <button type="button" onClick={() => setBulkSel((prev) => prev.size === plan.unassigned.length ? new Set() : new Set(plan.unassigned.map((u) => u.orderNo)))}
                  className="rounded px-1 py-0.5 hover:bg-accent hover:text-foreground">
                  {bulkSel.size === plan.unassigned.length ? t('bulk.selectNone') : t('bulk.selectAll')}
                </button>
                {bulkSel.size > 0 && <span className="tnum">{t('bulk.nSelected', { n: bulkSel.size })}</span>}
              </div>
            )}
            <div className="max-h-44 overflow-y-auto">
              {plan.unassigned.map((u) => {
                const canDrag = !!onAssignOrder && !solving;
                return (
                  <div key={u.orderNo} className="flex items-center gap-1 border-t border-divider">
                    {onBulkAssign && (
                      <input type="checkbox" checked={bulkSel.has(u.orderNo)} onChange={() => toggleBulk(u.orderNo)}
                        aria-label={t('bulk.selectOrder', { o: u.orderNo })}
                        className="ml-1.5 h-3.5 w-3.5 shrink-0 accent-[var(--primary)]" />
                    )}
                    <button type="button" onClick={() => onSelect({ kind: 'unassigned', orderNo: u.orderNo })}
                      draggable={canDrag}
                      onDragStart={canDrag ? (e) => setDraggedOrder(e, u.orderNo) : undefined}
                      title={canDrag ? t('fleet.dragToAssign') : undefined}
                      className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1.5 text-left text-xs hover:bg-accent ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''} ${selUnassigned === u.orderNo ? 'bg-accent' : ''}`}>
                      {canDrag && <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{u.customer ?? u.orderNo}</span>
                        <span className="tnum block text-muted-foreground">#{u.orderNo}{u.city ? ` · ${u.city}` : ''}</span>
                      </span>
                    </button>
                  </div>
                );
              })}
              {plan.unassigned.length === 0 && <p className="py-2 pl-2 text-xs text-muted-foreground">{t('fleet.allAssigned')}</p>}
            </div>
            {onBulkAssign && bulkSel.size > 0 && (
              <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/5 p-1.5">
                <select value={bulkVeh} onChange={(e) => setBulkVeh(e.target.value)} disabled={solving}
                  aria-label={t('bulk.toVehicle')}
                  className="h-7 min-w-0 flex-1 rounded border border-divider bg-card px-1 text-[11px] disabled:opacity-40">
                  <option value="">{t('bulk.toVehicle')}</option>
                  {plan.vehicles.filter((v) => !scenario.removedVehicleIds.includes(v.id)).map((v) => (
                    <option key={v.id} value={v.id}>{v.ref}{v.vehicleClass ? ` · ${v.vehicleClass.replace(/_/g, ' ')}` : ''}</option>
                  ))}
                </select>
                <button type="button" disabled={!bulkVeh || solving}
                  onClick={() => { onBulkAssign([...bulkSel], Number(bulkVeh)); setBulkSel(new Set()); setBulkVeh(''); }}
                  className="shrink-0 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
                  {t('bulk.assign')}
                </button>
                <button type="button" onClick={() => setBulkSel(new Set())} className="shrink-0 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent">
                  {t('bulk.clear')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
