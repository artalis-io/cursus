CREATE TABLE planning_profiles (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('fleet','locations')),
  version integer NOT NULL DEFAULT 0 CHECK(version >= 0),
  active_revision integer,
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE planning_profile_revisions (
  tenant_id text NOT NULL,
  profile_id text NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  body jsonb NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  proposed_by uuid REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  PRIMARY KEY(tenant_id,profile_id,revision),
  FOREIGN KEY(tenant_id,profile_id) REFERENCES planning_profiles(tenant_id,id)
);
ALTER TABLE planning_profiles ADD CONSTRAINT planning_profiles_active_revision_fk
  FOREIGN KEY(tenant_id,id,active_revision)
  REFERENCES planning_profile_revisions(tenant_id,profile_id,revision);
CREATE FUNCTION protect_planning_profile_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'profile revisions are immutable'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
    OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at
    OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by))
  THEN RAISE EXCEPTION 'profile revision content and approval evidence are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER planning_profile_revision_immutable BEFORE UPDATE OR DELETE ON planning_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_planning_profile_revision();
INSERT INTO schema_migrations(version) VALUES(4);
