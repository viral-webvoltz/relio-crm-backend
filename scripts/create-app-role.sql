-- Run ONCE as a superuser (e.g. psql -U postgres -d crm -f scripts/create-app-role.sql), then point the API at the new role:
--   DATABASE_URL=postgres://crm_app:<strong password>@host:5432/crm
-- The API only needs to read/write rows. Keep the superuser for migrations (db:migrate) and one-off scripts only.
-- Replace the password before running.
CREATE ROLE crm_app LOGIN PASSWORD 'CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT CONNECT ON DATABASE crm TO crm_app;
GRANT USAGE ON SCHEMA public TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_app;

-- Tables created by future migrations get the same grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crm_app;

-- The audit trail is append-only for the app: it can write entries but never edit or erase them.
REVOKE UPDATE, DELETE ON audit_logs FROM crm_app;
