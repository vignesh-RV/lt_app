ALTER TABLE whatsapp_listener_accounts
    ADD COLUMN IF NOT EXISTS test_capture_enabled BOOLEAN NOT NULL DEFAULT FALSE;
