import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..'); // cursus/server
const cursusRoot = resolve(serverRoot, '..');
const defaultOttoRoot = resolve(cursusRoot, 'vendor/otto');

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function populationThreads(): number {
  const value = Number(env('DISPATCH_SOLVE_THREADS', '4'));
  if (!Number.isInteger(value) || value < 1 || value > 16)
    throw new Error('DISPATCH_SOLVE_THREADS must be an integer from 1 to 16');
  return value;
}

/*
 * the backend composes existing OTTO services; it does not reimplement them.
 *
 * - OTTO_ROOT holds the built C binaries (surge_solve) and dataset indexes.
 *   Cursus vendors OTTO at vendor/otto and uses its built artifacts by default.
 * - DATASET_ROOT is the immutable client dataset (never committed).
 * - CARTA/VELO/SAGE origins are reached over HTTP.
 */
export const config = {
  runtimeMode: env('CURSUS_RUNTIME_MODE', 'legacy') as 'legacy' | 'stateful',
  databaseUrl: env('CURSUS_DATABASE_URL', ''),
  databaseUrlFile: env('CURSUS_DATABASE_URL_FILE', ''),
  r2Endpoint: env('CURSUS_R2_ENDPOINT', ''),
  r2Bucket: env('CURSUS_R2_BUCKET', ''),
  r2AccessKeyIdFile: env('CURSUS_R2_ACCESS_KEY_ID_FILE', ''),
  r2SecretAccessKeyFile: env('CURSUS_R2_SECRET_ACCESS_KEY_FILE', ''),
  statefulWorkerId: env('CURSUS_WORKER_ID', 'cursus-worker'),
  statefulPollMs: Number(env('CURSUS_WORKER_POLL_MS', '1000')),
  statefulLeaseSec: Number(env('CURSUS_WORKER_LEASE_SEC', '120')),
  port: Number(env('DISPATCH_PORT', '8091')),
  host: env('DISPATCH_HOST', '127.0.0.1'),

  // ---- Security ----
  // A shared secret for the (future) auth layer. Today it gates binding to a
  // non-loopback host: the server refuses to listen on a public interface
  // without it, so an unauthenticated API is never exposed by a config slip.
  authToken: env('DISPATCH_AUTH_TOKEN', ''),
  authRequired: env('CURSUS_AUTH_REQUIRED', '0') === '1',
  authDatabase: env('CURSUS_AUTH_DATABASE', resolve(env('DISPATCH_DATA_DIR', resolve(serverRoot, 'data')), 'cursus.sqlite3')),
  authAllowedEmailsFile: env('CURSUS_AUTH_ALLOWED_EMAILS_FILE', ''),
  resendApiKeyFile: env('RESEND_API_KEY_FILE', ''),
  authPublicOrigin: env('CURSUS_PUBLIC_ORIGIN', 'http://127.0.0.1:8091'),
  authFrom: env('CURSUS_AUTH_FROM', 'Cursus <login@cursus.artalis.io>'),
  authTenantId: env('CURSUS_TENANT_ID', 'default'),
  authTenantName: env('CURSUS_TENANT_NAME', 'Cursus'),
  // Default-deny CORS: comma-separated allowed origins. Empty = same-origin only
  // (the SPA is served same-origin, so this is the correct default).
  corsOrigins: env('DISPATCH_CORS_ORIGINS', '').split(',').map((s) => s.trim()).filter(Boolean),
  // Content-Security-Policy for the backend-served SPA. Permits MapLibre's blob
  // workers + data/blob images and same-origin api/tiles; tune via env if needed.
  contentSecurityPolicy: env('DISPATCH_CSP',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; worker-src 'self' blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'"),
  // Carta tile proxy gets its own, more generous per-IP limit (a map view pulls
  // many tiles) but is no longer unthrottled.
  tileRateRps: Number(env('DISPATCH_TILE_RATE_RPS', '200')),
  tileRateBurst: Number(env('DISPATCH_TILE_RATE_BURST', '400')),

  ottoRoot: env('OTTO_ROOT', defaultOttoRoot),
  surgeBin: env('SURGE_BIN', resolve(env('OTTO_ROOT', defaultOttoRoot), 'surge/surge_solve')),

  datasetRoot: env('DATASET_ROOT', '/Users/mark/artalis.io/data/dataset'),

  cartaOrigin: env('CARTA_ORIGIN', 'http://127.0.0.1:8097'),
  veloOrigin: env('VELO_ORIGIN', 'http://127.0.0.1:8082'),
  sageOrigin: env('SAGE_ORIGIN', 'http://127.0.0.1:8084'),
  sageModel: env('SAGE_MODEL', 'sgdflash'),

  // Built SPA to serve. Absent in dev (Vite serves the app and proxies /api).
  webDist: env('WEB_DIST', resolve(serverRoot, '../web/dist')),

  // Local runtime store (scenarios/plans/jobs/geometry cache).
  dataDir: env('DISPATCH_DATA_DIR', resolve(serverRoot, 'data')),

  // Velo profile + polyline precision for road geometry (matches the matrices).
  veloProfile: env('VELO_PROFILE', 'truck'),
  polylinePrecision: 5,

  // Demo solve budget (seconds). The saved baseline used ~240s to reach 117/0;
  // live solves are honest about status/elapsed whatever the budget.
  solveTimeSeconds: Number(env('DISPATCH_SOLVE_SECONDS', '240')),
  solvePopulationThreads: populationThreads(),

  // Pseudonymize customer names (cities/coords kept). For shippable screenshots
  // of real plans without exposing client PII. Off by default (real demo).
  anonymize: env('DISPATCH_ANONYMIZE', '0') === '1',

  // ---- Robustness limits ----
  // Max solver subprocesses at once; further solves queue (pending -> running).
  maxConcurrentSolves: Number(env('DISPATCH_MAX_CONCURRENT_SOLVES', '2')),
  // Max solves waiting in the queue; beyond this the API returns 503 (backpressure).
  maxSolveQueue: Number(env('DISPATCH_MAX_SOLVE_QUEUE', '32')),
  // Max concurrent dataset admits (each holds a geocode + N^2 matrix build);
  // further admits wait. 1 keeps the single process from OOMing on parallel uploads.
  maxConcurrentImports: Number(env('DISPATCH_MAX_CONCURRENT_IMPORTS', '1')),
  // Hard-kill a solve this many seconds past its budget (SIGTERM, then SIGKILL).
  solveWatchdogGraceSec: Number(env('DISPATCH_SOLVE_GRACE_SEC', '20')),
  // Cap captured solver stdout; beyond this the job fails instead of OOMing.
  maxSolveOutputMB: Number(env('DISPATCH_MAX_SOLVE_OUTPUT_MB', '128')),
  // Retention: keep at most this many persisted plans / jobs / scenario copies
  // (oldest pruned; base scenarios are always kept).
  retainPlans: Number(env('DISPATCH_RETAIN_PLANS', '200')),
  retainJobs: Number(env('DISPATCH_RETAIN_JOBS', '200')),
  retainScenarios: Number(env('DISPATCH_RETAIN_SCENARIOS', '50')),
  // Cap the on-disk/in-memory road-geometry leg cache (oldest evicted). Bounds
  // what was an unbounded, fully-rewritten-per-persist file.
  geocacheMaxLegs: Number(env('DISPATCH_GEOCACHE_MAX_LEGS', '200000')),
  // Cap matrix_build stdout held in memory. For 1500 locations the all-pairs
  // text is ~70 MB, so 256 MB is ample headroom without the old 512 MB ceiling.
  matrixMaxBufferMB: Number(env('DISPATCH_MATRIX_MAX_BUFFER_MB', '256')),
  // Per-IP API rate limit (token bucket): sustained rps and burst.
  rateLimitRps: Number(env('DISPATCH_RATE_RPS', '40')),
  rateLimitBurst: Number(env('DISPATCH_RATE_BURST', '120')),

  // ---- Data onboarding (upload) ----
  // Where uploaded datasets live (external, never committed).
  uploadsDir: env('DISPATCH_UPLOADS_DIR', resolve(env('DATASET_ROOT', '/Users/mark/artalis.io/data/dataset'), 'uploads')),
  // Nexus engines (ingest.sh, reconcile.py, nx_pipeline) in vendored OTTO.
  nexusDir: env('NEXUS_DIR', resolve(env('OTTO_ROOT', defaultOttoRoot), 'nexus')),
  // Upload limits.
  maxUploadMB: Number(env('DISPATCH_MAX_UPLOAD_MB', '25')),
  maxUploadRows: Number(env('DISPATCH_MAX_UPLOAD_ROWS', '50000')),
  ingestTimeoutSec: Number(env('DISPATCH_INGEST_TIMEOUT_SEC', '90')),
  // Geocoding (reuse the dataset cache; keys-if-present else offline).
  geocodeCacheDir: env('GEOCODE_CACHE_DIR', resolve(env('DATASET_ROOT', '/Users/mark/artalis.io/data/dataset'), '.geocode_cache')),
  geocodePbf: env('GEOCODE_PBF', resolve(env('OTTO_ROOT', defaultOttoRoot), 'data/hungary-latest.osm.pbf')),
  geocodeEnv: env('GEOCODE_ENV', resolve(env('OTTO_ROOT', defaultOttoRoot), '.env')),
  geocodeForceOffline: env('DISPATCH_GEOCODE_OFFLINE', '0') === '1', // force cache-only even if keys exist
  geocodeTimeoutSec: Number(env('DISPATCH_GEOCODE_TIMEOUT_SEC', '180')),
  // Travel matrix (Velo all-pairs) for admitting an uploaded dataset.
  matrixBuildBin: env('MATRIX_BUILD_BIN', resolve(env('OTTO_ROOT', defaultOttoRoot), 'velo/matrix_build')),
  veloGraph: env('VELO_GRAPH', resolve(env('OTTO_ROOT', defaultOttoRoot), 'data/index/hungary-velo.vlg')),
  matrixTimeoutSec: Number(env('DISPATCH_MATRIX_TIMEOUT_SEC', '300')),
  maxMatrixLocations: Number(env('DISPATCH_MAX_MATRIX_LOCATIONS', '1500')),

  // When set, a missing required dependency path is a hard startup error rather
  // than a warning. The absolute-path defaults above are developer conveniences;
  // a real deployment should set the env vars and run strict.
  strictConfig: env('DISPATCH_STRICT_CONFIG', '0') === '1',
} as const;

export type Config = typeof config;

export interface MissingPath { variable: string; path: string; feature: string }
/* A11: turn "fails late and cryptically on a wrong path" into a clear startup
 * report. Returns the external-dependency paths that do not exist, each naming
 * the env var to set and the feature it blocks. The server logs these (and,
 * under strictConfig, refuses to start). */
export function missingConfigPaths(): MissingPath[] {
  const checks: MissingPath[] = [
    { variable: 'SURGE_BIN', path: config.surgeBin, feature: 'solving' },
    { variable: 'VELO_GRAPH', path: config.veloGraph, feature: 'travel matrix / dataset admit' },
    { variable: 'MATRIX_BUILD_BIN', path: config.matrixBuildBin, feature: 'dataset admit' },
    { variable: 'NEXUS_DIR/nx_pipeline', path: resolve(config.nexusDir, 'nx_pipeline'), feature: 'data onboarding' },
    { variable: 'DATASET_ROOT', path: config.datasetRoot, feature: 'built-in days + tariff' },
  ];
  return checks.filter((c) => !existsSync(c.path));
}
