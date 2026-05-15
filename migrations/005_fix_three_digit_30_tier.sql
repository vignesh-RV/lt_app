UPDATE game_pricing_rules
SET win_tiers = '{"ABC": 14000, "BC": 500, "C": 50}'::jsonb
WHERE game_key = 'three_digit_30';
