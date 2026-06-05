-- M4 Migration 12: payout_action_events
-- Immutable audit log -- one row per payout state transition (Global Rule 10).
-- actor_user_id is the admin (or the requesting user for the initial REQUESTED
-- row). idempotency_key UNIQUE guards one-time transitions; the paid transition
-- uses the literal shape payout_paid:{payout_request_id}.

CREATE TABLE payout_action_events (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_request_id UUID         NOT NULL REFERENCES payout_requests(id),
  actor_user_id     BIGINT       REFERENCES "User"(id),
  action            TEXT         NOT NULL
                      CHECK (action IN ('REQUESTED','APPROVED','PAID','REJECTED')),
  notes             TEXT,
  idempotency_key   VARCHAR(255) UNIQUE,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX payout_action_events_request_idx
  ON payout_action_events (payout_request_id, created_at);
