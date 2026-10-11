import type { ValidationViolation } from '@/types';

type TFn = (key: string, params?: Record<string, string | number>) => string;

/* A human, localized one-liner for a validation violation. Shared by the Issues
 * panel and the Inspector so the same HARD_TW/CAPACITY/TAIL_LIFT/VEHICLE_SIZE
 * never renders as a raw enum in one place and "late 12 min" in another. */
export function violationDetail(v: ValidationViolation, t: TFn): string {
  if (v.type === 'HARD_TW') return t('issues.lateBy', { n: Math.round(((v.actual ?? 0) - (v.limit ?? 0)) / 60) });
  if (v.type === 'CAPACITY') return t('issues.overBy', { n: Math.round((v.actual ?? 0) - (v.limit ?? 0)), dim: v.dimension ?? '' });
  if (v.type === 'TAIL_LIFT') return t('issues.tailLift');
  if (v.type === 'VEHICLE_SIZE') return t('issues.oversize', { a: v.actual ?? '—', b: v.limit ?? '—' });
  return v.type;
}
