/** Operator-only, no HTTP role-assignment endpoint. Uses existing mounted
 * configuration; never creates users, memberships, sessions or email intents. */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import { isRole } from './roles.js';
import { AuthService } from './auth.js';
import { StatefulAuthService } from './state/auth.js';
import { StatefulStore } from './state/postgres.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, role: { type: 'string' }, tenant: { type: 'string' }, approve: { type: 'boolean' } } });
if (!values.approve || !values.email || !isRole(values.role) || values.tenant !== config.authTenantId)
  throw new Error('requires --email, --role admin|planner|reviewer, --tenant matching CURSUS_TENANT_ID, and --approve');
if (config.runtimeMode === 'stateful') {
  const url = config.databaseUrlFile ? (await readFile(config.databaseUrlFile, 'utf8')).trim() : config.databaseUrl;
  if (!url) throw new Error('database configuration required');
  const store = new StatefulStore(url);
  try {
    const auth = new StatefulAuthService(store, { allowedEmailsFile: config.authAllowedEmailsFile, publicOrigin: config.authPublicOrigin,
      from: config.authFrom, tenantId: config.authTenantId, tenantName: config.authTenantName, secureCookies: true });
    await auth.setRole(values.email, values.role);
  } finally { await store.close(); }
} else {
  const auth = new AuthService({ databasePath: config.authDatabase, allowedEmailsFile: config.authAllowedEmailsFile,
    resendApiKeyFile: config.resendApiKeyFile, publicOrigin: config.authPublicOrigin, from: config.authFrom,
    tenantId: config.authTenantId, tenantName: config.authTenantName, secureCookies: true });
  try { auth.setRole(values.email, values.role); } finally { auth.close(); }
}
console.log('Tenant membership role updated (or already matched); audit recorded for changes.');
