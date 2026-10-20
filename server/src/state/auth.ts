import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { StatefulStore } from './postgres.js';
import type { Principal } from '../auth.js';
import { isRole, parseRoleAllowlist, type Role } from '../roles.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const normalize = (value: string): string => value.trim().toLowerCase();

export interface StatefulAuthConfig {
  allowedEmailsFile: string; publicOrigin: string; from: string;
  tenantId: string; tenantName: string; secureCookies: boolean;
}

/** PostgreSQL authentication adapter. Magic-link creation and its email intent
 * commit in one transaction; provider I/O is exclusively an outbox concern. */
export class StatefulAuthService {
  private allowed: Map<string, Role>;
  constructor(private store: StatefulStore, private config: StatefulAuthConfig) {
    this.allowed = parseRoleAllowlist(readFileSync(config.allowedEmailsFile, 'utf8'));
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
      await client.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [this.config.tenantId, userId, this.allowed.get(email)!]);
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
      AND m.user_id=s.user_id AND m.tenant_id=s.tenant_id AND m.role IN ('admin','reviewer')
      RETURNING s.user_id "userId",s.tenant_id "tenantId",u.email,m.role`, [sha256(session)]);
    const row = rows[0];
    return row && isRole(row.role) && row.tenantId === this.config.tenantId && this.allowed.has(row.email) ? row : null;
  }

  async setRole(email: string, role: Role): Promise<void> {
    if (!isRole(role)) throw new Error('invalid role');
    await this.store.tx(async client => {
      // Serialize all operator role changes for this tenant, including the
      // last-admin check, without resetting sessions or creating identities.
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [this.config.tenantId]);
      const { rows } = await client.query<{ userId: string; role: Role }>(`SELECT m.user_id "userId",m.role FROM memberships m
        JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.email=$2 FOR UPDATE OF m`, [this.config.tenantId, normalize(email)]);
      const member = rows[0];
      if (!member) throw new Error('existing tenant membership required');
      if (member.role === role) return;
      const admins = await client.query("SELECT count(*)::int n FROM memberships WHERE tenant_id=$1 AND role='admin'", [this.config.tenantId]);
      if (member.role === 'admin' && role === 'reviewer' && admins.rows[0]!.n <= 1) throw new Error('cannot demote the last tenant administrator');
      await client.query('UPDATE memberships SET role=$1 WHERE tenant_id=$2 AND user_id=$3', [role, this.config.tenantId, member.userId]);
      await client.query("INSERT INTO audit_events(tenant_id,user_id,action,detail) VALUES($1,$2,'membership.role_changed',$3)",
        [this.config.tenantId, member.userId, { previousRole: member.role, role, actor: 'operator' }]);
    });
  }

  async logout(session: string | undefined): Promise<void> {
    if (session) await this.store.pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [sha256(session)]);
  }
  cookie(token: string): string { return `cursus_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${this.config.secureCookies ? '; Secure' : ''}`; }
  clearCookie(): string { return `cursus_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.config.secureCookies ? '; Secure' : ''}`; }
  async close(): Promise<void> { /* store lifecycle is owned by the runtime */ }
}
