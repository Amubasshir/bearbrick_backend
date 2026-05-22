-- M3d Migration 3: leaderboard_period_finalizations
-- The period-close idempotency guard. Written by period-finalization-worker
-- when a rotating period's UTC end has passed. The row is the contract:
-- "this period is closed, top_snapshot is authoritative, reward issuance may
-- run." Idempotency key shape: 'lb_finalization:{leaderboard_key}:{period_key}'
-- — asserted by string equality in tests, following the M3c precedent.
--
-- top_snapshot shape:
--   [{ "rank": 1, "user_id": "...", "score": "1850.0000",
--      "tie_break_timestamp": "2026-05-21T14:23:11Z",
--      "tie_break_event_id": "..." }, ...]
-- covering top-N (config: leaderboard.top_snapshot_size; default N = 10).

CREATE TABLE leaderboard_period_finalizations (
  id                    BIGSERIAL    PRIMARY KEY,
  leaderboard_key       VARCHAR(80)  NOT NULL,
  period_key            VARCHAR(20)  NOT NULL,
  finalized_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  total_eligible_users  INTEGER      NOT NULL DEFAULT 0,
  top_snapshot          JSONB        NOT NULL,
  idempotency_key       VARCHAR(255) NOT NULL UNIQUE,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT leaderboard_period_finalizations_key_period_unique
    UNIQUE (leaderboard_key, period_key),
  CONSTRAINT leaderboard_period_finalizations_eligible_nonneg
    CHECK (total_eligible_users >= 0)
);

CREATE INDEX leaderboard_period_finalizations_key_idx
  ON leaderboard_period_finalizations (leaderboard_key, finalized_at DESC);
