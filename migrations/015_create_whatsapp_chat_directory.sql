CREATE TABLE IF NOT EXISTS whatsapp_chat_directory (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT REFERENCES whatsapp_listener_accounts(id) ON DELETE CASCADE,
    account_key TEXT NOT NULL DEFAULT '',
    jid TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    chat_type TEXT NOT NULL DEFAULT 'chat' CHECK (chat_type IN ('chat', 'group')),
    source TEXT NOT NULL DEFAULT '',
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, jid)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_chat_directory_account
    ON whatsapp_chat_directory (account_id, chat_type, display_name);

INSERT INTO whatsapp_chat_directory (
    account_id,
    account_key,
    jid,
    display_name,
    chat_type,
    source,
    last_seen_at
)
SELECT DISTINCT ON (m.account_id, m.remote_jid)
    m.account_id,
    m.account_key,
    m.remote_jid,
    COALESCE(NULLIF(m.push_name, ''), m.remote_jid),
    CASE WHEN m.remote_jid ILIKE '%@g.us' THEN 'group' ELSE 'chat' END,
    'inbound_history',
    m.received_at
FROM whatsapp_inbound_messages m
WHERE COALESCE(m.remote_jid, '') <> ''
ON CONFLICT (account_id, jid) DO NOTHING;

INSERT INTO whatsapp_chat_directory (
    account_id,
    account_key,
    jid,
    display_name,
    chat_type,
    source,
    last_seen_at
)
SELECT DISTINCT ON (e.account_id, e.remote_jid)
    e.account_id,
    e.account_key,
    e.remote_jid,
    e.remote_jid,
    CASE WHEN e.remote_jid ILIKE '%@g.us' THEN 'group' ELSE 'chat' END,
    'event_history',
    e.created_at
FROM whatsapp_listener_events e
WHERE e.account_id IS NOT NULL
  AND COALESCE(e.remote_jid, '') <> ''
ON CONFLICT (account_id, jid) DO NOTHING;
