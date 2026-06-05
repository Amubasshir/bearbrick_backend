-- M4 Migration 9: payout_requests
-- Per spec section 17.6. Payout state machine REQUESTED -> APPROVED -> PAID,
-- or -> REJECTED. Reserved-cash accounting lives on user_balances; this row
-- records the request. idempotency_key (Q9) is set on the Mark-Paid transition
-- (shape payout_paid:{payout_request_id}); combined with the paid_at IS NULL
-- in-transaction guard, a double Mark-Paid is a no-op. Multiple pending requests
-- are allowed (Q10) -- each reserves separately via user_balances.

CREATE TABLE payout_requests (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         BIGINT       NOT NULL REFERENCES "User"(id),
  amount_cents    INTEGER      NOT NULL,
  payout_method   TEXT         NOT NULL CHECK (payout_method IN ('PAYPAL','VENMO')),
  payout_handle   TEXT         NOT NULL,
  status          TEXT         NOT NULL
                    CHECK (status IN ('REQUESTED','APPROVED','PAID','REJECTED'))
                    DEFAULT 'REQUESTED',
  admin_notes     TEXT,
  reviewed_by     BIGINT       REFERENCES "User"(id),
  reviewed_at     TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  idempotency_key VARCHAR(255) UNIQUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT payout_requests_amount_positive CHECK (amount_cents > 0)
);

CREATE INDEX payout_requests_user_idx   ON payout_requests (user_id, created_at DESC);
CREATE INDEX payout_requests_status_idx ON payout_requests (status, created_at);
