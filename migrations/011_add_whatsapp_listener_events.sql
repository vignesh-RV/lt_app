CREATE TABLE IF NOT EXISTS whatsapp_listener_events (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT REFERENCES whatsapp_listener_accounts(id) ON DELETE CASCADE,
    account_key TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    remote_jid TEXT NOT NULL DEFAULT '',
    sender_jid TEXT NOT NULL DEFAULT '',
    message_text TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_listener_events_account
    ON whatsapp_listener_events (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_listener_events_type
    ON whatsapp_listener_events (event_type, created_at DESC);
