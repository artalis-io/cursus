import { readFileSync } from 'node:fs';

export interface BuildInfo { version: string; revision: string | null }

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** Read immutable image metadata, not a mutable deployment environment override.
 * Source checkouts without an image manifest honestly report an unknown build. */
export function readBuildInfo(path: string | URL): BuildInfo {
  let revision: string | null = null;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { revision?: unknown };
    if (typeof manifest.revision === 'string' && /^[a-f0-9]{40}$/i.test(manifest.revision)) revision = manifest.revision;
  } catch { /* Development checkout, missing or invalid metadata. */ }
  return { version, revision };
}

export const buildInfo = readBuildInfo(new URL('../../build-info.json', import.meta.url));
