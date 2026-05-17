ALTER TABLE app_licenses
    ADD COLUMN IF NOT EXISTS credit_api_base_url TEXT,
    ADD COLUMN IF NOT EXISTS credit_api_path TEXT NOT NULL DEFAULT '/api/credits';

