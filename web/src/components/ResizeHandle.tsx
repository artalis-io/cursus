import { useRef, useState, type PointerEvent } from 'react';
import { clamp } from '@/lib/workspace-layout';

/** A UI-only splitter. Pointer capture and a temporary shield prevent resize
 * gestures from leaking into map navigation or native stop drag-and-drop. */
export function ResizeHandle({ label, help, controls, axis, direction, value, min, max, onChange, onReset }: {
  label: string; help: string; controls: string; axis: 'x' | 'y'; direction: 1 | -1;
  value: number; min: number; max: number; onChange: (size: number) => void; onReset: () => void;
}) {
  const drag = useRef<{ id: number; coordinate: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const enabled = max > min;
  const coordinate = (e: PointerEvent) => axis === 'x' ? e.clientX : e.clientY;
  const move = (e: PointerEvent) => {
    const start = drag.current;
    if (!start || start.id !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    onChange(Math.round(clamp(start.value + direction * (coordinate(e) - start.coordinate), min, max)));
  };
  const finish = (cancel: boolean) => {
    const start = drag.current;
    drag.current = null;
    setDragging(false);
    if (start && cancel) onChange(start.value);
  };
  return <>
    {dragging && <div aria-hidden className={`fixed inset-0 z-50 select-none ${axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize'}`} />}
    <div role="separator" aria-label={label} aria-controls={controls} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} px`}
      aria-disabled={!enabled || undefined} tabIndex={enabled ? 0 : -1} title={help}
      className={`relative z-20 shrink-0 touch-none select-none bg-divider transition-colors hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${axis === 'x' ? 'w-[6px] cursor-col-resize' : 'h-[6px] cursor-row-resize'} ${dragging ? 'z-[60] bg-primary' : ''}`}
      onDragStart={e => e.preventDefault()}
      onPointerDown={e => {
        if (!enabled || e.button !== 0 || !e.isPrimary) return;
        e.preventDefault(); e.stopPropagation(); e.currentTarget.focus();
        drag.current = { id: e.pointerId, coordinate: coordinate(e), value };
        e.currentTarget.setPointerCapture(e.pointerId); setDragging(true);
      }}
      onPointerMove={move}
      onPointerUp={e => {
        if (drag.current?.id !== e.pointerId) return;
        move(e); finish(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} onBlur={() => { if (drag.current) finish(true); }}
      onClick={e => { e.preventDefault(); e.stopPropagation(); }}
      onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); if (enabled) onReset(); }}
      onKeyDown={e => {
        if (e.key === 'Escape' && drag.current) { e.preventDefault(); finish(true); return; }
        if (!enabled || e.altKey || e.ctrlKey || e.metaKey) return;
        const delta = axis === 'x' ? e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
          : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (!delta && !['Home', 'End'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        onChange(e.key === 'Home' ? min : e.key === 'End' ? max : clamp(value + delta * direction * (e.shiftKey ? 40 : 10), min, max));
      }}>
      <span aria-hidden className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-muted-foreground/50 ${axis === 'x' ? 'h-6 w-0.5' : 'h-0.5 w-6'}`} />
    </div>
  </>;
}
