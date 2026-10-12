import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthService } from './auth.js';

test('allowlisted one-time magic link creates and revokes an admin session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cursus-auth-'));
  writeFileSync(join(root, 'allowlist'), 'admin@example.test\n');
  writeFileSync(join(root, 'resend'), 'test-key\n');
  let sentBody = '';
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => { sentBody = String(init?.body); return new Response('{}', { status: 200 }); };
  const auth = new AuthService({ databasePath: join(root, 'db.sqlite3'), allowedEmailsFile: join(root, 'allowlist'), resendApiKeyFile: join(root, 'resend'), publicOrigin: 'https://cursus.example.test', from: 'Cursus <login@example.test>', tenantId: 'tenant-1', tenantName: 'Tenant One', secureCookies: true });
  try {
    await auth.requestMagicLink(' ADMIN@example.test ');
    const html = (JSON.parse(sentBody) as { html: string }).html;
    const token = decodeURIComponent(html.match(/token=([^"&]+)/)?.[1] ?? '');
    assert.ok(token);
    const session = auth.consumeMagicLink(token);
    assert.ok(session);
    assert.equal(auth.consumeMagicLink(token), null, 'magic link must be one-use');
    const principal = auth.authenticate(session!);
    assert.deepEqual(principal, { userId: principal?.userId, tenantId: 'tenant-1', email: 'admin@example.test', role: 'admin' });
    assert.match(auth.cookie(session!), /HttpOnly.*SameSite=Lax.*Secure/);
    auth.logout(session!);
    assert.equal(auth.authenticate(session!), null);
  } finally {
    auth.close(); globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true });
  }
});

test('unapproved address is indistinguishable and sends nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cursus-auth-'));
  writeFileSync(join(root, 'allowlist'), 'admin@example.test\n');
  writeFileSync(join(root, 'resend'), 'test-key\n');
  let sends = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { sends++; return new Response('{}'); };
  const auth = new AuthService({ databasePath: join(root, 'db.sqlite3'), allowedEmailsFile: join(root, 'allowlist'), resendApiKeyFile: join(root, 'resend'), publicOrigin: 'https://cursus.example.test', from: 'Cursus <login@example.test>', tenantId: 'tenant-1', tenantName: 'Tenant One', secureCookies: true });
  try { await auth.requestMagicLink('stranger@example.test'); assert.equal(sends, 0); }
  finally { auth.close(); globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); }
});
