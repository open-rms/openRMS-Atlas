-- Creates this service's own role and database on any PostgreSQL 16+ server: local Docker, a
-- managed host or your own. Run once, as a role allowed to create roles and databases:
--
--   psql "$ADMIN_DATABASE_URL" -v password="$(openssl rand -base64 24)" -f db/bootstrap.sql
--
-- Then set DATABASE_URL=postgres://openrms_directory:<password>@<host>/openrms_directory (add ?sslmode=require for
-- a remote server) and start the service: migrations run at startup. The role owns only its own
-- database and cannot connect to other services' databases. Rename freely; nothing else depends
-- on these names.
\set ON_ERROR_STOP on
CREATE ROLE openrms_directory LOGIN PASSWORD :'password';
CREATE DATABASE openrms_directory OWNER openrms_directory;
REVOKE ALL ON DATABASE openrms_directory FROM PUBLIC;
