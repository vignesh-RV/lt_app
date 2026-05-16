CREATE TABLE IF NOT EXISTS app_licenses (
    id BIGSERIAL PRIMARY KEY,
    customer_name TEXT NOT NULL DEFAULT '',
    mobile_number TEXT NOT NULL,
    normalized_mobile TEXT NOT NULL,
    device_id TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'blocked', 'expired')),
    expires_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_licenses_normalized_mobile
    ON app_licenses (normalized_mobile);

CREATE INDEX IF NOT EXISTS idx_app_licenses_device_id
    ON app_licenses (device_id)
    WHERE device_id IS NOT NULL;
