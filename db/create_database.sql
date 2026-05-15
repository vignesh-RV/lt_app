-- Run this as a Postgres admin user, for example `postgres`.
-- This file uses psql's \gexec command for CREATE DATABASE IF NOT EXISTS behavior.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user LOGIN PASSWORD 'Micro@2026';
    ELSE
        ALTER ROLE app_user WITH LOGIN PASSWORD 'Micro@2026';
    END IF;
END
$$;

SELECT 'CREATE DATABASE wa_bank_monitor OWNER app_user'
WHERE NOT EXISTS (
    SELECT 1
    FROM pg_database
    WHERE datname = 'wa_bank_monitor'
)\gexec

GRANT ALL PRIVILEGES ON DATABASE wa_bank_monitor TO app_user;
