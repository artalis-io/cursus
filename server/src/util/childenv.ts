/* Build a minimal environment for a child process instead of spreading the
 * whole parent `process.env`. The geocoder makes outbound HTTP calls, so it
 * should not inherit every secret the server happens to hold; it loads its API
 * keys from its own --env file, not from these variables. Only the handful a
 * CLI/Python tool genuinely needs (lookup path, locale, tmp, proxy) are passed. */
const ALLOW = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
  'SYSTEMROOT', 'PYTHONPATH', 'PYTHONHOME', 'USER', 'LOGNAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

export function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ALLOW) { const v = process.env[k]; if (v != null) out[k] = v; }
  return { ...out, ...extra };
}
