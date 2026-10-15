import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthService } from './auth.js';
import { magicLinkConfirmation } from './magic-link.js';
import { readBuildInfo } from './build-info.js';

test('build metadata reports only a full image revision, with an honest missing-metadata fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'cursus-build-'));
  const manifest = join(root, 'build-info.json');
  try {
    assert.equal(readBuildInfo(manifest).revision, null);
    const revision = 'a'.repeat(40);
    writeFileSync(manifest, JSON.stringify({ revision }));
    assert.equal(readBuildInfo(manifest).revision, revision);
    assert.match(readBuildInfo(manifest).version, /^\d+\.\d+\.\d+/);
    for (const value of ['unknown', 'abc1234', '<script>', null, 42]) {
      writeFileSync(manifest, JSON.stringify({ revision: value }));
      assert.equal(readBuildInfo(manifest).revision, null);
    }
    writeFileSync(manifest, 'invalid json');
    assert.equal(readBuildInfo(manifest).revision, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('magic-link confirmation is branded, self-contained and keeps credentials in an explicit POST', () => {
  const html = magicLinkConfirmation('\"><script>alert(1)</script>&token=other');
  assert.match(html, /<header aria-label="Cursus">/);
  assert.match(html, /aria-labelledby="confirmation-title"/);
  assert.match(html, /<style>/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /method="post" action="\/api\/auth\/verify\?token=%22%3E%3Cscript%3Ealert\(1\)%3C%2Fscript%3E%26token%3Dother"/);
  assert.match(html, /enctype="application\/x-www-form-urlencoded"/);
  assert.doesNotMatch(html, /<script|<link|https?:\/\//i);
  assert.equal((html.match(/<form /g) ?? []).length, 1);
});

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
