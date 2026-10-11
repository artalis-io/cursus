import { writeFileSync, renameSync } from 'node:fs';

/* Atomic JSON write: write a temp file then rename over the target, so a crash
 * mid-write leaves the previous file intact rather than a half-written/corrupt
 * one. The temp name includes the pid so two processes never collide. rename is
 * atomic only within a filesystem; all callers write inside the data dir, so
 * the temp and target are always on the same volume. */
export function writeJsonAtomic(path: string, obj: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, path);
}
