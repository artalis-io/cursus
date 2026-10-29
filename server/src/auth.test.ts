import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthService } from './auth.js';
import { magicLinkConfirmation, magicLinkLanguage } from './magic-link.js';
import { readBuildInfo } from './build-info.js';
import { workspaceBranding, gyermelyiIcon } from './workspace-branding.js';
import { createStatefulApi } from './state/api.js';
import type { StatefulStore } from './state/postgres.js';
import type { StatefulAuthService } from './state/auth.js';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { registerAccessControl } from './access-control.js';
import { parseRoleAllowlist, hasPermission, permissions, type Role, type Permission } from './roles.js';
import { routePermission } from './route-permissions.js';
import type { Principal } from './auth.js';

test('permission grants match an independent specification, not production-derived expectations', () => {
  const expected: Record<Role, string[]> = {
    reviewer: ['workspace.read', 'workspace.export'],
    planner: ['workspace.read', 'workspace.export', 'scenario.create', 'scenario.rename', 'scenario.edit',
      'scenario.import', 'plan.evaluate', 'plan.review', 'optimization.submit', 'optimization.cancel', 'analysis.generate','profile.propose'],
    admin: ['workspace.read', 'workspace.export', 'scenario.create', 'scenario.rename', 'scenario.edit', 'scenario.import',
      'scenario.delete', 'plan.evaluate', 'plan.review', 'plan.approve', 'optimization.submit', 'optimization.cancel', 'analysis.generate',
      'dataset.upload', 'dataset.convert', 'dataset.validate', 'dataset.admit', 'dataset.delete', 'role.preview','profile.propose','profile.approve'],
  };
  for (const role of ['admin', 'planner', 'reviewer'] as const)
    assert.deepEqual(permissions.filter(p => hasPermission(role, p)).sort(), expected[role].sort());
  for (const role of [null, undefined, 'owner', 'ADMIN'])
    for (const permission of permissions) assert.equal(hasPermission(role, permission), false);
  assert.equal(parseRoleAllowlist('{"planners":["planner@example.test"]}').get('planner@example.test'), 'planner');
});

test('unclassified routes fail registration, including GET; public exceptions are method-specific', async () => {
  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    const app = Fastify(); registerAccessControl(app);
    assert.throws(() => app.route({ method, url: '/api/new-feature', handler: async () => ({}) }), /Unclassified/);
    await app.close();
  }
  assert.equal(routePermission('POST', '/api/auth/me'), undefined);
  assert.equal(routePermission('GET', '/api/import/admit'), undefined);
});

test('an unavailable audit store prevents authorized business work from executing', async () => {
  const app = Fastify(); let touched = false;
  registerAccessControl(app, { tenantId: 't', publicOrigin: 'https://cursus.example.test',
    authenticate: () => ({ userId: 'u', email: 'p@example.test', tenantId: 't', role: 'planner' }),
    audit: () => { throw Error('audit unavailable'); } });
  app.post('/api/scenarios', async () => { touched = true; return {}; });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/scenarios', headers: { origin: 'https://cursus.example.test' } })).statusCode, 500);
    assert.equal(touched, false);
  } finally { await app.close(); }
});

test('Planner API permission matrix blocks native work, object writes and shared deletion before handlers', async () => {
  for (const asyncAuth of [false, true]) {
    const app = Fastify(); const touched: string[] = [], audited: Record<string, unknown>[] = [];
    let role: Role = 'planner';
    registerAccessControl(app, { tenantId: 't', publicOrigin: 'https://cursus.example.test',
      authenticate: () => { const p = { userId: 'u', email: 'p@example.test', tenantId: 't', role }; return asyncAuth ? Promise.resolve(p) : p; },
      audit: (_p, detail) => { audited.push(detail); } });
    const cases: [string, string, Permission, boolean][] = [
      ['POST', '/api/scenarios', 'scenario.create', true], ['POST', '/api/scenarios/:id/edit', 'scenario.edit', true],
      ['POST', '/api/scenarios/:id/edits', 'scenario.edit', true], ['POST', '/api/scenarios/:id/rename', 'scenario.rename', true],
      ['POST', '/api/scenarios/import', 'scenario.import', true], ['POST', '/api/scenarios/:id/solve', 'optimization.submit', true],
      ['POST', '/api/plans/:id/evaluate', 'plan.evaluate', true], ['DELETE', '/api/jobs/:id', 'optimization.cancel', true],
      ['POST', '/api/plans/:id/narrate', 'analysis.generate', true], ['POST', '/api/compare/narrate', 'analysis.generate', true],
      ['DELETE', '/api/scenarios/:id', 'scenario.delete', false], ['DELETE', '/api/import/datasets/:id', 'dataset.delete', false],
      ['POST', '/api/import/upload', 'dataset.upload', false], ['POST', '/api/import/preview', 'dataset.upload', false],
      ['POST', '/api/import/geocode', 'dataset.convert', false], ['POST', '/api/import/admit', 'dataset.admit', false],
      ['POST', '/api/import/datasets/:id/validate', 'dataset.validate', false],
      ['POST', '/api/import/datasets/:id/admit', 'dataset.admit', false], ['POST', '/api/import/datasets/:id/convert', 'dataset.convert', false],
    ];
    for (const [method, url] of cases) app.route({ method: method as 'POST' | 'DELETE', url,
      handler: async () => { touched.push(`${method} ${url}`); return { ok: true }; } });
    try {
      for (const [method, route, permission, allowed] of cases) {
        assert.equal(routePermission(method, route), permission);
        const before = touched.length;
        const response = await app.inject({ method: method as 'POST' | 'DELETE', url: route.replace(':id', 'id'),
          headers: { origin: 'https://cursus.example.test', 'x-role': 'admin' } });
        assert.equal(response.statusCode, allowed ? 200 : 403, route);
        assert.equal(touched.length, before + Number(allowed));
      }
      assert.equal(audited.length, cases.filter(c => c[3]).length);
      assert.ok(audited.every(e => e.role === 'planner' && e.effectiveRole === 'planner'));
      role = 'reviewer';
      assert.equal((await app.inject({ method: 'POST', url: '/api/scenarios', headers: { origin: 'https://cursus.example.test' } })).statusCode, 403);
      role = 'admin';
      assert.equal((await app.inject({ method: 'DELETE', url: '/api/scenarios/id', headers: { origin: 'https://cursus.example.test' } })).statusCode, 200);
    } finally { await app.close(); }
  }
});

test('Admin Reviewer preview is read-only, reversible, session-bound and cannot elevate Reviewers', async () => {
  for (const asyncAuth of [false, true]) {
    const app = Fastify();
    let role: 'admin' | 'reviewer' = 'admin';
    registerAccessControl(app, { tenantId: 'tenant', publicOrigin: 'https://cursus.example.test', authenticate: token => {
      const principal = token ? { userId: 'u', email: 'admin@example.test', tenantId: 'tenant', role } : null;
      return asyncAuth ? Promise.resolve(principal) : principal;
    } });
    app.post('/api/write', { config: { permission: 'scenario.edit' } }, async () => ({ ok: true }));
    const headers = { origin: 'https://cursus.example.test', cookie: 'cursus_session=one' };
    try {
      const enable = await app.inject({ method: 'POST', url: '/api/auth/view-as', headers, payload: { role: 'reviewer' } });
      assert.equal(enable.statusCode, 200);
      const cookie = String(enable.headers['set-cookie']).split(';')[0];
      const preview = { ...headers, cookie: `${headers.cookie}; ${cookie}` };
      assert.equal((await app.inject({ method: 'POST', url: '/api/write', headers: preview })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/view-as', headers: preview, payload: { role: null } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: '/api/write', headers })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: '/api/write', headers: { ...headers, cookie: `cursus_session=two; ${cookie}` } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/view-as', headers: { ...headers, origin: 'https://evil.test' }, payload: { role: null } })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/view-as', headers, payload: { role: 'admin' } })).statusCode, 400);
      role = 'reviewer';
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/view-as', headers: preview, payload: { role: null } })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: '/api/write', headers })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/view-as', payload: { role: 'reviewer' } })).statusCode, 401);
    } finally { await app.close(); }
  }
});

test('explicit role allowlists fail closed and preserve historical admin bootstrap', () => {
  assert.equal(parseRoleAllowlist('Admin@example.test\n').get('admin@example.test'), 'admin');
  const roles = parseRoleAllowlist('{"admins":["admin@example.test"],"reviewers":["reviewer@example.test"]}');
  assert.equal(roles.get('reviewer@example.test'), 'reviewer');
  for (const value of ['', '{}', '{"owners":[]}', '{"admins":"admin@example.test"}',
    '{"admins":["same@example.test"],"reviewers":["SAME@example.test"]}', '{"reviewers":[3]}']) assert.throws(() => parseRoleAllowlist(value));
});

test('both sync and async runtimes deny all Reviewer mutation methods before handlers', async () => {
  for (const asyncAuth of [false, true]) {
    const app = Fastify(); let mutations = 0;
    let principal: Principal | null = { userId: 'u', email: 'reader@example.test', tenantId: 'tenant', role: 'reviewer' };
    registerAccessControl(app, { tenantId: 'tenant', publicOrigin: 'https://cursus.example.test',
      authenticate: () => asyncAuth ? Promise.resolve(principal) : principal });
    app.get('/api/fixture', { config: { permission: 'workspace.read' } }, async () => ({ readable: true }));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const)
      app.route({ method, url: '/api/fixture', config: { permission: 'scenario.edit' }, handler: async () => { mutations++; return { changed: true }; } });
    try {
      assert.equal((await app.inject('/api/fixture')).statusCode, 200);
      assert.equal((await app.inject({ method: 'HEAD', url: '/api/fixture' })).statusCode, 200);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const denied = await app.inject({ method, url: '/api/fixture?role=admin', headers: { origin: 'https://cursus.example.test', 'x-role': 'admin' } });
        assert.equal(denied.statusCode, 403);
      }
      assert.equal(mutations, 0);
      principal = { ...principal!, role: 'admin' };
      assert.equal((await app.inject({ method: 'POST', url: '/api/fixture' })).statusCode, 403, 'Admin still requires same origin');
      assert.equal((await app.inject({ method: 'POST', url: '/api/fixture', headers: { origin: 'https://cursus.example.test' } })).statusCode, 200);
      principal = { ...principal, tenantId: 'other' };
      assert.equal((await app.inject('/api/fixture')).statusCode, 401);
      principal = null;
      assert.equal((await app.inject('/api/fixture')).statusCode, 401);
    } finally { await app.close(); }
  }
});

test('stateful Reviewer API rejects edits, uploads, compute and future writes without touching repositories', async () => {
  const store = { ensureTenant: async () => {}, listScenarios: async () => [],listPlans:async()=>[] } as unknown as StatefulStore;
  const auth = { initialize: async () => {}, authenticate: async () => ({ userId: 'u', tenantId: 't', email: 'reader@example.test', role: 'reviewer' }) } as unknown as StatefulAuthService;
  const app = await createStatefulApi({ store, auth, tenantId: 't', tenantName: 'Tenant', publicOrigin: 'https://cursus.example.test' });
  try {
    assert.equal((await app.inject('/api/scenarios')).statusCode, 200);
    for (const url of ['/api/scenarios', '/api/scenarios/import', '/api/scenarios/id/edit', '/api/scenarios/id/edits',
      '/api/scenarios/id/rename', '/api/scenarios/id/solve','/api/scenarios/id/select-plan', '/api/plans/id/evaluate', '/api/plans/id/narrate', '/api/compare/narrate',
      '/api/import/upload', '/api/import/preview', '/api/import/geocode', '/api/import/admit',
      '/api/import/datasets/id/validate', '/api/import/datasets/id/admit', '/api/import/datasets/id/convert', '/api/future-mutation'])
      assert.equal((await app.inject({ method: 'POST', url, headers: { origin: 'https://cursus.example.test' } })).statusCode, 403, url);
    for (const url of ['/api/scenarios/id', '/api/jobs/id', '/api/import/datasets/id'])
      assert.equal((await app.inject({ method: 'DELETE', url, headers: { origin: 'https://cursus.example.test' } })).statusCode, 403, url);
  } finally { await app.close(); }
});

test('SQLite upgrade preserves sessions and reads role changes without login elevation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cursus-reviewer-'));
  const allow = join(root, 'allowed'), dbPath = join(root, 'auth.sqlite'), key = join(root, 'resend');
  writeFileSync(allow, JSON.stringify({ admins: ['one@example.test', 'two@example.test'], planners: ['planner@example.test'], reviewers: ['reader@example.test'] }));
  writeFileSync(key, 'test-key');
  const cfg = { databasePath: dbPath, allowedEmailsFile: allow, resendApiKeyFile: key, publicOrigin: 'https://cursus.example.test',
    from: 'Cursus <login@example.test>', tenantId: 't', tenantName: 'Tenant', secureCookies: true };
  const oldFetch = globalThis.fetch; let html = '';
  globalThis.fetch = async (_input, init) => { html = JSON.parse(String(init?.body)).html; return new Response('{}'); };
  let auth = new AuthService(cfg);
  const login = async (email: string) => {
    await auth.requestMagicLink(email);
    const token = decodeURIComponent(html.match(/token=([^"<]+)/)![1]!);
    const session = auth.consumeMagicLink(token); assert.ok(session); return session;
  };
  try {
    const one = await login('one@example.test'); await login('two@example.test');
    const reader = await login('reader@example.test');
    const planner = await login('planner@example.test');
    assert.equal(auth.authenticate(planner)?.role, 'planner');
    auth.setRole('planner@example.test', 'reviewer');
    assert.equal(auth.authenticate(planner)?.role, 'reviewer');
    await login('planner@example.test');
    assert.equal(auth.authenticate(planner)?.role, 'reviewer');
    assert.equal(auth.authenticate(reader)?.role, 'reviewer');
    auth.setRole('one@example.test', 'reviewer');
    assert.equal(auth.authenticate(one)?.role, 'reviewer');
    await login('one@example.test');
    assert.equal(auth.authenticate(one)?.role, 'reviewer', 'admin bootstrap config never elevates an existing membership');
    assert.throws(() => auth.setRole('two@example.test', 'reviewer'), /last tenant administrator/);
    assert.throws(() => auth.setRole('two@example.test', 'planner'), /last tenant administrator/);
    assert.throws(() => auth.setRole('missing@example.test', 'reviewer'), /existing tenant membership/);
    auth.setRole('one@example.test', 'admin');
    auth.close();
    const db = new Database(dbPath);
    db.exec("DELETE FROM memberships WHERE role='reviewer'; ALTER TABLE memberships RENAME TO previous_memberships; CREATE TABLE memberships(tenant_id TEXT NOT NULL REFERENCES tenants(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('admin')),created_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,user_id)); INSERT INTO memberships SELECT * FROM previous_memberships; DROP TABLE previous_memberships; DELETE FROM schema_migrations WHERE version>=2;");
    db.close();
    auth = new AuthService(cfg);
    assert.equal(auth.authenticate(one)?.role, 'admin', 'v1 migration preserves existing sessions and memberships');
    auth.setRole('one@example.test', 'reviewer');
    assert.equal(auth.authenticate(one)?.role, 'reviewer');
  } finally { auth.close(); globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); }
});

test('public workspace branding is explicitly deployment-scoped, not user-selected', async () => {
  for (const name of ['Gyermelyi', ' GYERMELYI ', 'Other customer', 'Gyermelyi demo', '<img src=x>']) {
    const branded = name.trim().toLowerCase() === 'gyermelyi';
    const store = { ensureTenant: async () => {} } as unknown as StatefulStore;
    const auth = { initialize: async () => {}, authenticate: async () => null } as unknown as StatefulAuthService;
    const app = await createStatefulApi({ store, auth, tenantId: 'private-id', tenantName: name });
    try {
      const response = await app.inject({ url: '/api/auth/workspace?tenant=Gyermelyi' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json(), { branding: workspaceBranding(name) });
      assert.equal(response.body.includes('private-id'), false);
      const icon = await app.inject({ url: '/api/auth/workspace/icon' });
      assert.equal(icon.statusCode, branded ? 200 : 404);
      if (branded) { assert.equal(icon.headers['content-type'], 'image/png'); assert.deepEqual(icon.rawPayload, gyermelyiIcon()); }
      assert.equal((await app.inject({ url: '/api/days' })).statusCode, 401);
      assert.equal((await app.inject({ url: '/api/auth/me' })).statusCode, 401);
    } finally { await app.close(); }
  }
});

test('Gyermelyi confirmation embeds local artwork without sending the token to third parties', () => {
  const html = magicLinkConfirmation('test-token', 'Gyermelyi');
  assert.match(html, /Gyermelyi workspace/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /https?:\/\/|<script|<link/i);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /method="post" action="\/api\/auth\/verify\?token=test-token"/);
  assert.doesNotMatch(magicLinkConfirmation('test-token', 'Other workspace'), /Gyermelyi|data:image/);
});

test('Hungarian confirmation keeps token encoding and POST-only consumption unchanged', () => {
  assert.equal(magicLinkLanguage(undefined, 'hu-HU,hu;q=0.9,en;q=0.8'), 'hu');
  assert.equal(magicLinkLanguage('en', 'hu-HU'), 'en');
  assert.equal(magicLinkLanguage('<script>', 'en-US'), 'en');
  const html = magicLinkConfirmation('a&other=unsafe', 'Gyermelyi', 'hu');
  assert.match(html, /<html lang="hu">/);
  assert.match(html, /Gyermelyi munkatér/);
  assert.match(html, /Tovább a Cursusba/);
  assert.match(html, /method="post" action="\/api\/auth\/verify\?token=a%26other%3Dunsafe"/);
  assert.doesNotMatch(html, /<script|https?:\/\//i);
});

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
