CREATE TABLE IF NOT EXISTS whatsapp_customer_payment_balances (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES whatsapp_listener_accounts(id) ON DELETE CASCADE,
    remote_jid TEXT NOT NULL DEFAULT '',
    sender_jid TEXT NOT NULL DEFAULT '',
    show_code TEXT NOT NULL DEFAULT '',
    balance_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    last_payment_proof_id BIGINT REFERENCES whatsapp_payment_proofs(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, remote_jid, sender_jid, show_code)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_customer_payment_balances_lookup
    ON whatsapp_customer_payment_balances (account_id, show_code, updated_at DESC);

