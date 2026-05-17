CREATE TABLE IF NOT EXISTS whatsapp_forward_targets (
    id BIGSERIAL PRIMARY KEY,
    show_code TEXT NOT NULL UNIQUE,
    destination_jid TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE whatsapp_inbound_messages
    ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS forwarded_to_jid TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS forwarded_by_payment_proof_id BIGINT,
    ADD COLUMN IF NOT EXISTS forward_error TEXT NOT NULL DEFAULT '';

ALTER TABLE whatsapp_payment_proofs
    ADD COLUMN IF NOT EXISTS matched_booking_id BIGINT REFERENCES whatsapp_inbound_messages(id),
    ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS forward_error TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_messages_forward_pending
    ON whatsapp_inbound_messages (account_id, show_code, received_at DESC)
    WHERE forwarded_at IS NULL;
