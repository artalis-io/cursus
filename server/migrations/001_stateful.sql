CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text REFERENCES tenants(id),
  user_id uuid REFERENCES users(id),
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenarios (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  revision bigint NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS plans (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  scenario_id text NOT NULL,
  scenario_revision bigint NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS objects (
  tenant_id text NOT NULL REFERENCES tenants(id),
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  media_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('staged','published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id, object_key)
);
CREATE TABLE IF NOT EXISTS datasets (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  manifest jsonb NOT NULL,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','validated','admitted','failed')),
  schema_version integer NOT NULL DEFAULT 1,
  failure text,
  validated_at timestamptz,
  admitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'uploaded';
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS failure text;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS validated_at timestamptz;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS admitted_at timestamptz;

CREATE TABLE IF NOT EXISTS jobs (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('solve','dataset-admit')),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  fence bigint NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs (kind, state, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS email_outbox (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed')),
  attempt integer NOT NULL DEFAULT 0,
  fence bigint NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outbox_claim ON email_outbox (state, next_attempt_at, lease_expires_at, created_at);

INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
