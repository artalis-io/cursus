-- Additive membership capability. Existing identities, sessions and admin
-- assignments are retained. Old app versions cannot authenticate Reviewers.
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('admin','reviewer'));
INSERT INTO schema_migrations(version) VALUES (2);
