ALTER TABLE whatsapp_inbound_messages
    ADD COLUMN IF NOT EXISTS calculated_price NUMERIC(14, 2),
    ADD COLUMN IF NOT EXISTS pricing_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS manual_work BOOLEAN NOT NULL DEFAULT FALSE;
