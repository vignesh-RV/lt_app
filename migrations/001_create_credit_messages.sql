CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_credit_messages (
    id BIGSERIAL PRIMARY KEY,
    unique_id TEXT NOT NULL UNIQUE,
    message_source TEXT NOT NULL,
    source TEXT NOT NULL,
    app_package TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'credit' CHECK (direction = 'credit'),
    amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
    sender TEXT,
    transaction_date_text TEXT,
    payer_name TEXT,
    payer_vpa TEXT,
    account_hint TEXT,
    transaction_id TEXT,
    raw_text TEXT NOT NULL,
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_credit_messages_received_at
    ON bank_credit_messages (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_bank_credit_messages_transaction_id
    ON bank_credit_messages (transaction_id)
    WHERE transaction_id IS NOT NULL AND transaction_id <> '';

CREATE INDEX IF NOT EXISTS idx_bank_credit_messages_message_source
    ON bank_credit_messages (message_source);
