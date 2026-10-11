import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from '../config.js';

/* All-pairs travel matrix via Velo's matrix_build (one-to-all Dijkstra per
 * source). Feeds "id\tlat\tlon" on stdin; parses the "M i j duration_s
 * distance_m" lines (diagonal is 0) and the "S idx node snap_m" snap lines. */

export interface MatrixLoc { id: string; lat: number; lon: number }
export interface TravelMatrix {
  locationCount: number;
  distances: number[];   // meters, row-major i*N+j
  durations: number[];   // seconds
  snapWarnings: { index: number; meters: number }[];
}

export async function buildMatrix(locs: MatrixLoc[], profile = config.veloProfile): Promise<TravelMatrix> {
  if (locs.length < 2) throw new Error('need at least 2 locations');
  if (locs.length > config.maxMatrixLocations) throw new Error(`too many locations (${locs.length} > ${config.maxMatrixLocations})`);
  if (!existsSync(config.matrixBuildBin)) throw new Error(`matrix_build not built at ${config.matrixBuildBin} (make -C velo tools)`);
  if (!existsSync(config.veloGraph)) throw new Error(`velo graph missing at ${config.veloGraph}`);

  const stdin = locs.map((l, i) => `${i}\t${l.lat}\t${l.lon}`).join('\n') + '\n';
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      config.matrixBuildBin, [config.veloGraph, '--profile', profile, '--weight', 'duration'],
      { timeout: config.matrixTimeoutSec * 1000, maxBuffer: Math.max(1, config.matrixMaxBufferMB) * 1024 * 1024 },
      (err, out) => {
        if (err) { reject(new Error((err as { killed?: boolean }).killed ? `matrix build timed out after ${config.matrixTimeoutSec}s` : `matrix build failed: ${err.message}`)); return; }
        resolve(out);
      },
    );
    child.stdin?.end(stdin);
  });

  const N = locs.length;
  const distances = new Array(N * N).fill(0);
  const durations = new Array(N * N).fill(0);
  const snapWarnings: { index: number; meters: number }[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const f = line.split(/\s+/);
    if (f[0] === 'M') {
      const a = Number(f[1]), b = Number(f[2]);
      const d = Number(f[3]), m = Number(f[4]);
      // Guard NaN explicitly: a malformed field would otherwise poison the cell
      // (the `?? 0` leg getters catch undefined/null, not NaN).
      if (a >= 0 && a < N && b >= 0 && b < N && Number.isFinite(d) && Number.isFinite(m)) {
        durations[a * N + b] = Math.round(d); distances[a * N + b] = Math.round(m);
      }
    } else if (f[0] === 'S') {
      const m = Number(f[3]);
      if (Number.isFinite(m) && m > 500) snapWarnings.push({ index: Number(f[1]), meters: Math.round(m) });
    }
  }
  return { locationCount: N, distances, durations, snapWarnings };
}
