import { useEffect, useState } from 'react';
import { DEFAULT_LAYOUT, LAYOUT_KEY, LIMITS, clamp, fitLayout, parseLayout, type WorkspaceLayout } from '@/lib/workspace-layout';
import { DEFAULT_VISIBILITY, VISIBILITY_KEY, parseVisibility } from '@/lib/workspace-layout';

export function useWorkspaceLayout(fleetOpen: boolean, inspectorOpen: boolean) {
  const [visibility, setVisibility] = useState(() => {
    try { return parseVisibility(localStorage.getItem(VISIBILITY_KEY)); } catch { return { ...DEFAULT_VISIBILITY }; }
  });
  useEffect(() => {
    try { localStorage.setItem(VISIBILITY_KEY, JSON.stringify({ version: 1, ...visibility })); } catch { /* Personal layout still works without storage. */ }
  }, [visibility]);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [preferred, setPreferred] = useState<WorkspaceLayout>(() => {
    try { return parseLayout(localStorage.getItem(LAYOUT_KEY)); } catch { return { ...DEFAULT_LAYOUT }; }
  });
  useEffect(() => {
    if (!container) return;
    const measure = () => { const rect = container.getBoundingClientRect(); setBounds({ width: rect.width, height: rect.height }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);
  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, ...preferred })); } catch { /* Storage may be unavailable; layout still works. */ }
  }, [preferred]);
  const setSize = (key: keyof WorkspaceLayout, value: number) => {
    if (Number.isFinite(value)) setPreferred(p => {
      const current = fitLayout(p, bounds.width, bounds.height, fleetOpen, inspectorOpen);
      const next = { ...p, [key]: Math.round(clamp(value, LIMITS[key][0], LIMITS[key][1])) };
      // Once the USER resizes a fitted sidebar, anchor its sibling at the
      // currently visible width. Otherwise an old oversized sibling preference
      // could make dragging right paradoxically shrink the active panel.
      if (current.desktop && key === 'fleet' && inspectorOpen) next.inspector = current.inspector;
      if (current.desktop && key === 'inspector' && fleetOpen) next.fleet = current.fleet;
      return next;
    });
  };
  return { containerRef: setContainer, layout: fitLayout(preferred, bounds.width, bounds.height, fleetOpen, inspectorOpen),
    visibility, toggleVisibility: (key: keyof typeof DEFAULT_VISIBILITY) => setVisibility(v => ({ ...v, [key]: !v[key] })),
    setSize, reset: () => { setPreferred({ ...DEFAULT_LAYOUT }); setVisibility({ ...DEFAULT_VISIBILITY }); }, resetSize: (key: keyof WorkspaceLayout) => setSize(key, DEFAULT_LAYOUT[key]) };
}
