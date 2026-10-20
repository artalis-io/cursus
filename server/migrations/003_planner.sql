-- Preserve all memberships and sessions; only expand the role domain.
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('admin','planner','reviewer'));
INSERT INTO schema_migrations(version) VALUES (3);
