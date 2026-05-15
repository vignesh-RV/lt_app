CREATE TABLE IF NOT EXISTS show_results (
    id BIGSERIAL PRIMARY KEY,
    result_date DATE NOT NULL,
    game_show TEXT NOT NULL,
    market TEXT NOT NULL,
    winning_number TEXT NOT NULL CHECK (winning_number ~ '^[0-9]{1,4}$'),
    entered_by TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (result_date, game_show)
);

CREATE TABLE IF NOT EXISTS winning_lines (
    id BIGSERIAL PRIMARY KEY,
    show_result_id BIGINT NOT NULL REFERENCES show_results(id) ON DELETE CASCADE,
    prediction_request_id BIGINT NOT NULL REFERENCES prediction_requests(id),
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    entry_index INTEGER NOT NULL,
    raw_line TEXT NOT NULL,
    game_mode TEXT NOT NULL,
    matched_tier TEXT NOT NULL,
    predicted_number TEXT NOT NULL,
    normalized_number TEXT,
    winning_number TEXT NOT NULL,
    unit_price NUMERIC(14, 2) NOT NULL,
    units INTEGER NOT NULL,
    win_amount_per_unit NUMERIC(14, 2) NOT NULL,
    payout_amount NUMERIC(14, 2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_disbursement'
        CHECK (status IN ('pending_disbursement', 'disbursed', 'cancelled')),
    disbursed_at TIMESTAMPTZ,
    disbursement_reference TEXT,
    disbursement_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (show_result_id, prediction_request_id, entry_index, matched_tier)
);

CREATE INDEX IF NOT EXISTS idx_show_results_date_show
    ON show_results (result_date DESC, game_show);

CREATE INDEX IF NOT EXISTS idx_winning_lines_show_result_id
    ON winning_lines (show_result_id);

CREATE INDEX IF NOT EXISTS idx_winning_lines_customer_id
    ON winning_lines (customer_id);

CREATE INDEX IF NOT EXISTS idx_winning_lines_status
    ON winning_lines (status);
