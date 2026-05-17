CREATE TABLE IF NOT EXISTS whatsapp_payment_proofs (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT REFERENCES whatsapp_listener_accounts(id) ON DELETE SET NULL,
    account_key TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL,
    remote_jid TEXT NOT NULL DEFAULT '',
    sender_jid TEXT NOT NULL DEFAULT '',
    push_name TEXT NOT NULL DEFAULT '',
    media_type TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    ocr_text TEXT NOT NULL DEFAULT '',
    proof_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    amount NUMERIC(14, 2),
    transaction_id TEXT NOT NULL DEFAULT '',
    utr TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'parsed'
        CHECK (status IN ('parsed', 'ocr_failed', 'matched', 'amount_mismatch', 'not_found')),
    matched_credit_id BIGINT REFERENCES bank_credit_messages(id),
    received_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_payment_proofs_account
    ON whatsapp_payment_proofs (account_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_payment_proofs_reference
    ON whatsapp_payment_proofs (transaction_id, utr);
