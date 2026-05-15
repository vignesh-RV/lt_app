ALTER TABLE bank_credit_messages
    ADD COLUMN IF NOT EXISTS device_id TEXT,
    ADD COLUMN IF NOT EXISTS device_name TEXT,
    ADD COLUMN IF NOT EXISTS device_manufacturer TEXT,
    ADD COLUMN IF NOT EXISTS device_model TEXT,
    ADD COLUMN IF NOT EXISTS phone_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS received_phone_number TEXT,
    ADD COLUMN IF NOT EXISTS sms_subscription_id TEXT;

CREATE INDEX IF NOT EXISTS idx_bank_credit_messages_device_id
    ON bank_credit_messages (device_id)
    WHERE device_id IS NOT NULL AND device_id <> '';

CREATE INDEX IF NOT EXISTS idx_bank_credit_messages_received_phone_number
    ON bank_credit_messages (received_phone_number)
    WHERE received_phone_number IS NOT NULL AND received_phone_number <> '';
