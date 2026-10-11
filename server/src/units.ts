/* Unit helpers. Surge works in seconds-from-midnight and meters; the UI shows
 * HH:MM and km. Keep conversions explicit and in one place. */

export const metersToKm = (m: number): number => Math.round((m / 1000) * 10) / 10;

export function secToHHMM(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* Parse "H:MM"/"HH:MM" local time to seconds-from-midnight, or null. */
export function hhmmToSec(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}
