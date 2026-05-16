ALTER TABLE prediction_requests
    DROP CONSTRAINT IF EXISTS prediction_requests_status_check;

ALTER TABLE prediction_requests
    ADD CONSTRAINT prediction_requests_status_check
    CHECK (status IN ('ignored', 'manual_work', 'pending_payment', 'paid', 'partial_payment', 'overpaid', 'cancelled'));
