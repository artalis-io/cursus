ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('solve','dataset-admit','handoff'));
ALTER TABLE jobs ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX jobs_available ON jobs(kind,state,available_at,created_at);

CREATE TABLE handoff_heads (
  tenant_id text NOT NULL REFERENCES tenants(id),
  scenario_id text NOT NULL,
  destination_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
  current_intent uuid,
  accepted_intent uuid,
  PRIMARY KEY(tenant_id,scenario_id,destination_id),
  CONSTRAINT handoff_heads_scenario_fk FOREIGN KEY(tenant_id,scenario_id) REFERENCES scenarios(tenant_id,id)
);
CREATE TABLE handoff_intents (
  tenant_id text NOT NULL,
  id uuid NOT NULL,
  scenario_id text NOT NULL,
  destination_id text NOT NULL,
  generation bigint NOT NULL CHECK(generation>0),
  operation_id text NOT NULL,
  request_sha256 text NOT NULL,
  destination_sha256 text NOT NULL,
  operation text NOT NULL CHECK(operation IN ('publish','amend','cancel')),
  reason text NOT NULL,
  plan_id text NOT NULL,
  scenario_revision bigint NOT NULL,
  approval_version bigint NOT NULL,
  plan_sha256 text NOT NULL,
  payload_text text NOT NULL,
  payload_sha256 text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','retrying','acknowledged','acknowledged_superseded','rejected','stale','needs_reconciliation')),
  attempts integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  acknowledged_at timestamptz,
  acknowledgement jsonb,
  last_error text,
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,operation_id),
  UNIQUE(tenant_id,scenario_id,destination_id,generation),
  UNIQUE(tenant_id,scenario_id,destination_id,id),
  UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,id) REFERENCES jobs(tenant_id,id),
  FOREIGN KEY(tenant_id,scenario_id,destination_id) REFERENCES handoff_heads(tenant_id,scenario_id,destination_id),
  FOREIGN KEY(tenant_id,plan_id) REFERENCES plans(tenant_id,id)
);
ALTER TABLE handoff_heads ADD CONSTRAINT handoff_heads_current_fk
  FOREIGN KEY(tenant_id,scenario_id,destination_id,current_intent) REFERENCES handoff_intents(tenant_id,scenario_id,destination_id,id);
ALTER TABLE handoff_heads ADD CONSTRAINT handoff_heads_accepted_fk
  FOREIGN KEY(tenant_id,scenario_id,destination_id,accepted_intent) REFERENCES handoff_intents(tenant_id,scenario_id,destination_id,id);
CREATE TABLE handoff_attempts (
  tenant_id text NOT NULL,
  intent_id uuid NOT NULL,
  attempt integer NOT NULL,
  fence bigint NOT NULL,
  method text NOT NULL CHECK(method IN ('GET','POST')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  outcome text NOT NULL DEFAULT 'started' CHECK(outcome IN ('started','accepted','rejected','ambiguous','interrupted','stale')),
  detail text,
  PRIMARY KEY(tenant_id,intent_id,attempt),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES handoff_intents(tenant_id,id)
);
CREATE FUNCTION protect_handoff_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'handoff intent is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','attempts','acknowledged_at','acknowledgement','last_error'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempts','acknowledged_at','acknowledgement','last_error'])
  THEN RAISE EXCEPTION 'handoff intent payload is immutable'; END IF;
  IF OLD.acknowledgement IS NOT NULL AND NEW.acknowledgement IS DISTINCT FROM OLD.acknowledgement
  THEN RAISE EXCEPTION 'handoff acknowledgement is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER handoff_intent_immutable BEFORE UPDATE OR DELETE ON handoff_intents
  FOR EACH ROW EXECUTE FUNCTION protect_handoff_intent();
INSERT INTO schema_migrations(version) VALUES(5);
