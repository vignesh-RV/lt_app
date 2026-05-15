CREATE TABLE IF NOT EXISTS game_pricing_rules (
    id BIGSERIAL PRIMARY KEY,
    game_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    digit_count INTEGER NOT NULL CHECK (digit_count BETWEEN 1 AND 4),
    unit_price NUMERIC(14, 2) NOT NULL CHECK (unit_price >= 0),
    allowed_markets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    position_code TEXT,
    win_tiers JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    priority INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE prediction_requests
    ADD COLUMN IF NOT EXISTS game_pricing_rule_id BIGINT REFERENCES game_pricing_rules(id),
    ADD COLUMN IF NOT EXISTS game_show TEXT,
    ADD COLUMN IF NOT EXISTS market TEXT,
    ADD COLUMN IF NOT EXISTS game_type TEXT,
    ADD COLUMN IF NOT EXISTS unit_price NUMERIC(14, 2),
    ADD COLUMN IF NOT EXISTS quantity INTEGER,
    ADD COLUMN IF NOT EXISTS parsed_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS pricing_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_prediction_requests_game_show
    ON prediction_requests (game_show);

CREATE INDEX IF NOT EXISTS idx_prediction_requests_game_pricing_rule_id
    ON prediction_requests (game_pricing_rule_id);

INSERT INTO game_pricing_rules (
    game_key,
    label,
    digit_count,
    unit_price,
    allowed_markets,
    position_code,
    win_tiers,
    priority
)
VALUES
    (
        'single_board_12',
        'Single Board',
        1,
        12.00,
        ARRAY['Dear', 'DR', 'KL'],
        NULL,
        '{"single": 100}'::jsonb,
        100
    ),
    (
        'two_digit_ab_12',
        '2 Digit AB',
        2,
        12.00,
        ARRAY['Dear', 'DR', 'KL'],
        'AB',
        '{"AB": 1000}'::jsonb,
        110
    ),
    (
        'two_digit_bc_12',
        '2 Digit BC',
        2,
        12.00,
        ARRAY['Dear', 'DR', 'KL'],
        'BC',
        '{"BC": 1000}'::jsonb,
        111
    ),
    (
        'two_digit_ac_12',
        '2 Digit AC',
        2,
        12.00,
        ARRAY['Dear', 'DR', 'KL'],
        'AC',
        '{"AC": 1000}'::jsonb,
        112
    ),
    (
        'three_digit_12',
        '3 Digit Rs 12',
        3,
        12.00,
        ARRAY['Dear', 'DR', 'KL'],
        NULL,
        '{"ABC": 4500, "BC": 100}'::jsonb,
        120
    ),
    (
        'three_digit_25',
        '3 Digit Rs 25',
        3,
        25.00,
        ARRAY['Dear', 'DR', 'KL'],
        NULL,
        '{"ABC": 9000, "BC": 1000}'::jsonb,
        121
    ),
    (
        'three_digit_30',
        '3 Digit Rs 30',
        3,
        30.00,
        ARRAY['Dear', 'DR', 'KL'],
        NULL,
        '{"ABC": 14000, "BC": 500, "C": 50}'::jsonb,
        122
    ),
    (
        'three_digit_60',
        '3 Digit Rs 60',
        3,
        60.00,
        ARRAY['Dear', 'DR', 'KL'],
        NULL,
        '{"ABC": 28000, "BC": 1000, "AC": 100}'::jsonb,
        123
    ),
    (
        'four_digit_only_kl_100',
        '4 Digit Only KL',
        4,
        100.00,
        ARRAY['KL'],
        NULL,
        '{"ABCD": 450000, "ABC": 10000, "BC": 1000, "C": 100}'::jsonb,
        130
    ),
    (
        'four_digit_kl_dear_20',
        '4 Digit KL & Dear',
        4,
        20.00,
        ARRAY['Dear', 'DR', 'KL'],
        NULL,
        '{"ABCD": 90000}'::jsonb,
        131
    )
ON CONFLICT (game_key) DO UPDATE SET
    label = EXCLUDED.label,
    digit_count = EXCLUDED.digit_count,
    unit_price = EXCLUDED.unit_price,
    allowed_markets = EXCLUDED.allowed_markets,
    position_code = EXCLUDED.position_code,
    win_tiers = EXCLUDED.win_tiers,
    is_active = TRUE,
    priority = EXCLUDED.priority;
