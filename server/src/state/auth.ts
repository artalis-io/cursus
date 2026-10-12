import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { StatefulStore } from './postgres.js';
import type { Principal } from '../auth.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const normalize = (value: string): string => value.trim().toLowerCase();

export interface StatefulAuthConfig {
  allowedEmailsFile: string; publicOrigin: string; from: string;
  tenantId: string; tenantName: string; secureCookies: boolean;
}

/** PostgreSQL authentication adapter. Magic-link creation and its email intent
 * commit in one transaction; provider I/O is exclusively an outbox concern. */
export class StatefulAuthService {
  private allowed: Set<string>;
  constructor(private store: StatefulStore, private config: StatefulAuthConfig) {
    this.allowed = new Set(readFileSync(config.allowedEmailsFile, 'utf8').split(/[\s,]+/).filter(Boolean).map(normalize));
    if (!this.allowed.size) throw new Error('authentication allowlist is empty');
  }

  async initialize(): Promise<void> { await this.store.ensureTenant(this.config.tenantId, this.config.tenantName); }

  async requestMagicLink(raw: string): Promise<void> {
    const email = normalize(raw);
    if (!this.allowed.has(email)) return;
    const token = randomBytes(32).toString('base64url');
    const link = `${this.config.publicOrigin.replace(/\/$/, '')}/api/auth/verify?token=${encodeURIComponent(token)}`;
    await this.store.tx(async (client) => {
      const user = await client.query<{ id: string }>(`INSERT INTO users(id,email) VALUES($1,$2)
        ON CONFLICT(email) DO UPDATE SET email=excluded.email RETURNING id`, [randomUUID(), email]);
      const userId = user.rows[0]!.id;
      await client.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING", [this.config.tenantId, userId]);
      await client.query('DELETE FROM magic_links WHERE expires_at < now() OR consumed_at IS NOT NULL');
      await client.query("INSERT INTO magic_links(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
        [sha256(token), userId, this.config.tenantId]);
      await this.store.enqueueEmail(client, this.config.tenantId, `magic-link/${sha256(token)}`, {
        from: this.config.from, to: [email], subject: 'Sign in to Cursus',
        html: `<p>Use this link to sign in to Cursus. It expires in 10 minutes and can be used once.</p><p><a href="${link}">Sign in to Cursus</a></p>`,
      });
      await client.query("INSERT INTO audit_events(tenant_id,user_id,action) VALUES($1,$2,'auth.magic_link_queued')", [this.config.tenantId, userId]);
    });
  }

  async consumeMagicLink(token: string): Promise<string | null> {
    return this.store.tx(async (client) => {
      const row = await client.query<{ userId: string; tenantId: string }>(`UPDATE magic_links SET consumed_at=now()
        WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>=now() RETURNING user_id "userId",tenant_id "tenantId"`, [sha256(token)]);
      if (!row.rows[0]) return null;
      const session = randomBytes(32).toString('base64url');
      await client.query("INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
        [sha256(session), row.rows[0].userId, row.rows[0].tenantId]);
      await client.query('UPDATE users SET last_login_at=now() WHERE id=$1', [row.rows[0].userId]);
      await client.query("INSERT INTO audit_events(tenant_id,user_id,action) VALUES($1,$2,'auth.login')", [row.rows[0].tenantId, row.rows[0].userId]);
      return session;
    });
  }

  async authenticate(session: string | undefined): Promise<Principal | null> {
    if (!session) return null;
    const { rows } = await this.store.pool.query<Principal>(`UPDATE sessions s SET last_seen_at=now() FROM users u,memberships m
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>=now() AND u.id=s.user_id
      AND m.user_id=s.user_id AND m.tenant_id=s.tenant_id AND m.role='admin'
      RETURNING s.user_id "userId",s.tenant_id "tenantId",u.email,m.role`, [sha256(session)]);
    return rows[0] ?? null;
  }

  async logout(session: string | undefined): Promise<void> {
    if (session) await this.store.pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [sha256(session)]);
  }
  cookie(token: string): string { return `cursus_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${this.config.secureCookies ? '; Secure' : ''}`; }
  clearCookie(): string { return `cursus_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.config.secureCookies ? '; Secure' : ''}`; }
  async close(): Promise<void> { /* store lifecycle is owned by the runtime */ }
}
