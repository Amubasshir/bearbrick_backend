-- M3d Migration 6: leaderboard_reward_events
-- Per spec §15.4. Immutable, append-only record of every reward issuance.
-- Idempotency key shape (literal string assertable in tests):
--   'lb_reward:{leaderboard_key}:{period_key}:{user_id}:{placement_tier}'
--
-- reward_bundle_snapshot is the FROZEN resolved bundle at issue time — a copy,
-- not a pointer. If leaderboard_rewards.reward_bundle is edited later, history
-- here remains intact. This is the audit-trail contract.
--
-- Two uniqueness layers:
--   1. UNIQUE (idempotency_key) — primary guard, matched literally
--   2. UNIQUE (user_id, lb_key, period_key, tier) — secondary safety net

CREATE TABLE leaderboard_reward_events (
  id                     BIGSERIAL        PRIMARY KEY,
  user_id                BIGINT           NOT NULL REFERENCES "User"(id),
  leaderboard_key        VARCHAR(80)      NOT NULL,
  period_key             VARCHAR(20)      NOT NULL,
  placement_tier         "PlacementTier"  NOT NULL,
  reward_bundle_snapshot JSONB            NOT NULL,
  idempotency_key        VARCHAR(255)     NOT NULL UNIQUE,
  created_at             TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CONSTRAINT leaderboard_reward_events_user_period_tier_unique
    UNIQUE (user_id, leaderboard_key, period_key, placement_tier)
);

CREATE INDEX leaderboard_reward_events_user_created_idx
  ON leaderboard_reward_events (user_id, created_at DESC);
CREATE INDEX leaderboard_reward_events_key_period_idx
  ON leaderboard_reward_events (leaderboard_key, period_key);
