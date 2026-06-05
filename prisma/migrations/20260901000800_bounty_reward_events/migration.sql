-- M4 Migration 8: bounty_reward_events
-- Per spec section 17.5. Immutable reward ledger. Two idempotency layers:
--   1. idempotency_key UNIQUE -- literal-string guard, mirrors the
--      leaderboard_reward_events.idempotency_key precedent. Shapes:
--        bounty_reward:{submission_id}:approved
--        bounty_reward:{submission_id}:approved_and_applied
--   2. UNIQUE (bounty_submission_id, event_type) -- secondary safety net (spec).
-- cash_delta_cents records the ACTUAL cash paid (0 when budget-capped, Q6);
-- credit_delta / xp_delta record the full captured rewards.

CREATE TABLE bounty_reward_events (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               BIGINT       NOT NULL REFERENCES "User"(id),
  bounty_submission_id  UUID         NOT NULL REFERENCES bounty_submissions(id),
  cash_delta_cents      INTEGER      NOT NULL DEFAULT 0,
  credit_delta          INTEGER      NOT NULL DEFAULT 0,
  xp_delta              INTEGER      NOT NULL DEFAULT 0,
  event_type            TEXT         NOT NULL
                          CHECK (event_type IN
                            ('BOUNTY_APPROVED','BOUNTY_APPROVED_AND_APPLIED','ADMIN_CORRECTION')),
  idempotency_key       VARCHAR(255) NOT NULL UNIQUE,
  created_by            BIGINT       REFERENCES "User"(id),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT bounty_reward_events_submission_type_unique
    UNIQUE (bounty_submission_id, event_type)
);

CREATE INDEX bounty_reward_events_user_idx ON bounty_reward_events (user_id, created_at DESC);
