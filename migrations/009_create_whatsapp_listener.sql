CREATE TABLE IF NOT EXISTS whatsapp_listener_accounts (
    id BIGSERIAL PRIMARY KEY,
    account_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    phone_number TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    listen_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    connected_jid TEXT NOT NULL DEFAULT '',
    last_status TEXT NOT NULL DEFAULT 'not_started',
    last_error TEXT NOT NULL DEFAULT '',
    latest_qr TEXT NOT NULL DEFAULT '',
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES whatsapp_listener_accounts(id) ON DELETE CASCADE,
    account_key TEXT NOT NULL,
    message_id TEXT NOT NULL,
    remote_jid TEXT NOT NULL DEFAULT '',
    sender_jid TEXT NOT NULL DEFAULT '',
    push_name TEXT NOT NULL DEFAULT '',
    message_text TEXT NOT NULL DEFAULT '',
    message_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    show_code TEXT NOT NULL DEFAULT '',
    listener_window JSONB NOT NULL DEFAULT '{}'::jsonb,
    received_at TIMESTAMPTZ NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'captured'
        CHECK (processing_status IN ('captured', 'priced', 'ignored', 'manual_work', 'audited')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_messages_show
    ON whatsapp_inbound_messages (show_code, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_messages_account
    ON whatsapp_inbound_messages (account_id, received_at DESC);
