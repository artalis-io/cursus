/* Display helpers. Surge times are seconds-from-midnight; show HH:MM. */

export function hhmm(secFromMidnight: number): string {
  const s = Math.max(0, Math.round(secFromMidnight));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function km(value: number, digits = 0): string {
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} km`;
}

export function seconds(value: number, digits = 1): string {
  return `${value.toFixed(digits)} s`;
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Money with a currency suffix. Large sums are shown compact (e.g. "1.44M Ft").
 * HUF renders as "Ft" (the Hungarian convention) and never with decimals. */
export function money(value: number, currency: string, compact = false): string {
  const unit = currency === 'HUF' ? 'Ft' : currency;
  if (compact && Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M ${unit}`;
  if (compact && Math.abs(value) >= 10_000) return `${Math.round(value / 1000)}k ${unit}`;
  return `${Math.round(value).toLocaleString('en-US')} ${unit}`;
}

/** Fraction in [0,1], clamped, for capacity bars. */
export function ratio(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(1, Math.max(0, used / cap));
}
