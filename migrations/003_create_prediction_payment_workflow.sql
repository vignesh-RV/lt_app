CREATE TABLE IF NOT EXISTS customers (
    id BIGSERIAL PRIMARY KEY,
    whatsapp_sender TEXT NOT NULL UNIQUE,
    display_name TEXT,
    phone_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prediction_pricing_rules (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    match_type TEXT NOT NULL CHECK (match_type IN ('contains', 'regex')),
    pattern TEXT NOT NULL,
    price NUMERIC(14, 2) NOT NULL CHECK (price >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    priority INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prediction_requests (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    message_source TEXT NOT NULL DEFAULT 'WhatsApp',
    whatsapp_sender TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    matched_rule_id BIGINT REFERENCES prediction_pricing_rules(id),
    calculated_price NUMERIC(14, 2),
    status TEXT NOT NULL DEFAULT 'pending_payment'
        CHECK (status IN ('ignored', 'pending_payment', 'paid', 'partial_payment', 'overpaid', 'cancelled')),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_proofs (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    prediction_request_id BIGINT REFERENCES prediction_requests(id),
    amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
    transaction_id TEXT,
    transaction_date_text TEXT,
    screenshot_path TEXT,
    raw_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending_match'
        CHECK (status IN ('pending_match', 'matched', 'amount_mismatch', 'not_found', 'rejected')),
    matched_credit_id BIGINT REFERENCES bank_credit_messages(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_utilizations (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    prediction_request_id BIGINT NOT NULL REFERENCES prediction_requests(id),
    credit_message_id BIGINT REFERENCES bank_credit_messages(id),
    payment_proof_id BIGINT REFERENCES payment_proofs(id),
    required_amount NUMERIC(14, 2) NOT NULL CHECK (required_amount >= 0),
    paid_amount NUMERIC(14, 2) NOT NULL CHECK (paid_amount >= 0),
    utilized_amount NUMERIC(14, 2) NOT NULL CHECK (utilized_amount >= 0),
    balance_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('fully_utilized', 'partial', 'balance_available')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_balances (
    customer_id BIGINT PRIMARY KEY REFERENCES customers(id),
    balance_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (balance_amount >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outbound_messages (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT REFERENCES customers(id),
    prediction_request_id BIGINT REFERENCES prediction_requests(id),
    whatsapp_sender TEXT NOT NULL,
    message_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_manual_send'
        CHECK (status IN ('pending_manual_send', 'opened_in_whatsapp', 'sent_manually', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prediction_requests_customer_id
    ON prediction_requests (customer_id);

CREATE INDEX IF NOT EXISTS idx_prediction_requests_status
    ON prediction_requests (status);

CREATE INDEX IF NOT EXISTS idx_payment_proofs_transaction_id
    ON payment_proofs (transaction_id)
    WHERE transaction_id IS NOT NULL AND transaction_id <> '';

CREATE INDEX IF NOT EXISTS idx_payment_utilizations_customer_id
    ON payment_utilizations (customer_id);

INSERT INTO prediction_pricing_rules (name, match_type, pattern, price, priority)
VALUES
    ('Sample single prediction', 'contains', 'single', 100.00, 100),
    ('Sample jackpot prediction', 'contains', 'jackpot', 800.00, 90),
    ('Sample regex prediction code', 'regex', '\\b(pred|prediction)\\s*[:#-]?\\s*[A-Za-z0-9]{2,}\\b', 250.00, 80)
ON CONFLICT DO NOTHING;
