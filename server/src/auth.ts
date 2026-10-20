import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRole, parseRoleAllowlist, type Role } from './roles.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const normalizeEmail = (value: string): string => value.trim().toLowerCase();
const now = (): number => Math.floor(Date.now() / 1000);

export interface AuthConfig {
  databasePath: string;
  allowedEmailsFile: string;
  resendApiKeyFile: string;
  publicOrigin: string;
  from: string;
  tenantId: string;
  tenantName: string;
  secureCookies: boolean;
}

export interface Principal { userId: string; tenantId: string; email: string; role: Role }

export class AuthService {
  private db: Database.Database;
  private allowed: Map<string, Role>;
  private resendKey: string;

  constructor(private config: AuthConfig) {
    mkdirSync(dirname(config.databasePath), { recursive: true });
    this.allowed = parseRoleAllowlist(readFileSync(config.allowedEmailsFile, 'utf8'));
    this.resendKey = readFileSync(config.resendApiKeyFile, 'utf8').trim();
    if (!this.allowed.size) throw new Error('authentication allowlist is empty');
    if (!this.resendKey) throw new Error('Resend API key is empty');
    this.db = new Database(config.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.db.prepare('INSERT OR IGNORE INTO tenants(id,name,created_at) VALUES(?,?,?)').run(config.tenantId, config.tenantName, now());
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES(1);
      CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_login_at INTEGER);
      CREATE TABLE IF NOT EXISTS memberships(
        tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK(role IN ('admin')), created_at INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,user_id));
      CREATE TABLE IF NOT EXISTS magic_links(
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tenant_id TEXT NOT NULL REFERENCES tenants(id),
        expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tenant_id TEXT NOT NULL REFERENCES tenants(id),
        expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, user_id TEXT, action TEXT NOT NULL,
        created_at INTEGER NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS magic_links_expiry ON magic_links(expires_at);
    `);
    if (!this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()) {
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE memberships_v2(
          tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
          role TEXT NOT NULL CHECK(role IN ('admin','reviewer')), created_at INTEGER NOT NULL,
          PRIMARY KEY(tenant_id,user_id));
          INSERT INTO memberships_v2 SELECT * FROM memberships;
          DROP TABLE memberships;
          ALTER TABLE memberships_v2 RENAME TO memberships;
          INSERT INTO schema_migrations(version) VALUES(2);`);
      })();
    }
  }

  isAllowed(raw: string): boolean { return this.allowed.has(normalizeEmail(raw)); }

  async requestMagicLink(raw: string): Promise<void> {
    const email = normalizeEmail(raw);
    if (!this.allowed.has(email)) return;
    const issued = this.db.transaction(() => {
      let user = this.db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string } | undefined;
      if (!user) {
        user = { id: randomUUID() };
        this.db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(user.id, email, now());
      }
      this.db.prepare('INSERT OR IGNORE INTO memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
        .run(this.config.tenantId, user.id, this.allowed.get(email)!, now());
      const token = randomBytes(32).toString('base64url');
      this.db.prepare('DELETE FROM magic_links WHERE expires_at < ? OR consumed_at IS NOT NULL').run(now());
      this.db.prepare('INSERT INTO magic_links(token_hash,user_id,tenant_id,expires_at,created_at) VALUES(?,?,?,?,?)')
        .run(sha256(token), user.id, this.config.tenantId, now() + 600, now());
      return { token, userId: user.id };
    })();
    const link = `${this.config.publicOrigin.replace(/\/$/, '')}/api/auth/verify?token=${encodeURIComponent(issued.token)}`;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.config.from, to: [email], subject: 'Sign in to Cursus', html: `<p>Use this link to sign in to Cursus. It expires in 10 minutes and can be used once.</p><p><a href="${link}">Sign in to Cursus</a></p>` }),
    });
    if (!response.ok) throw new Error(`Resend rejected magic link (${response.status})`);
    this.audit(this.config.tenantId, issued.userId, 'auth.magic_link_sent');
  }

  consumeMagicLink(token: string): string | null {
    const result = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT m.user_id userId,m.tenant_id tenantId,u.email
        FROM magic_links m JOIN users u ON u.id=m.user_id
        WHERE m.token_hash=? AND m.consumed_at IS NULL AND m.expires_at>=?`).get(sha256(token), now()) as Principal | undefined;
      if (!row) return null;
      this.db.prepare('UPDATE magic_links SET consumed_at=? WHERE token_hash=?').run(now(), sha256(token));
      const session = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?)')
        .run(sha256(session), row.userId, row.tenantId, now() + 7 * 86400, now(), now());
      this.db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now(), row.userId);
      this.audit(row.tenantId, row.userId, 'auth.login');
      return session;
    })();
    return result;
  }

  authenticate(session: string | undefined): Principal | null {
    if (!session) return null;
    const row = this.db.prepare(`SELECT s.user_id userId,s.tenant_id tenantId,u.email,m.role
      FROM sessions s JOIN users u ON u.id=s.user_id
      JOIN memberships m ON m.user_id=s.user_id AND m.tenant_id=s.tenant_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>=?`).get(sha256(session), now()) as Principal | undefined;
    if (!row || !isRole(row.role) || row.tenantId !== this.config.tenantId || !this.isAllowed(row.email)) return null;
    this.db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(now(), sha256(session));
    return row;
  }

  logout(session: string | undefined): void {
    if (!session) return;
    this.db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(now(), sha256(session));
  }

  setRole(email: string, role: Role): void {
    if (!isRole(role)) throw new Error('invalid role');
    this.db.transaction(() => {
      const member = this.db.prepare(`SELECT m.user_id userId,m.role FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=? AND u.email=?`).get(this.config.tenantId, normalizeEmail(email)) as { userId: string; role: Role } | undefined;
      if (!member) throw new Error('existing tenant membership required');
      if (member.role === role) return;
      if (member.role === 'admin' && role === 'reviewer' &&
          (this.db.prepare("SELECT count(*) n FROM memberships WHERE tenant_id=? AND role='admin'").get(this.config.tenantId) as { n: number }).n <= 1)
        throw new Error('cannot demote the last tenant administrator');
      this.db.prepare('UPDATE memberships SET role=? WHERE tenant_id=? AND user_id=?').run(role, this.config.tenantId, member.userId);
      this.db.prepare('INSERT INTO audit_events(tenant_id,user_id,action,created_at,detail_json) VALUES(?,?,?,?,?)')
        .run(this.config.tenantId, member.userId, 'membership.role_changed', now(), JSON.stringify({ previousRole: member.role, role, actor: 'operator' }));
    }).immediate();
  }

  cookie(token: string): string {
    return `cursus_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${this.config.secureCookies ? '; Secure' : ''}`;
  }
  clearCookie(): string { return `cursus_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.config.secureCookies ? '; Secure' : ''}`; }
  close(): void { this.db.close(); }
  private audit(tenantId: string, userId: string, action: string): void {
    this.db.prepare('INSERT INTO audit_events(tenant_id,user_id,action,created_at) VALUES(?,?,?,?)').run(tenantId, userId, action, now());
  }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
