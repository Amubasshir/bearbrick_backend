-- M3d Migration 5: leaderboard_rewards
-- Per spec §15.3. Reward configuration: which cosmetic bundle is awarded for
-- each (board, period, placement_tier). period_key = '*' is the wildcard that
-- means "every period of this board" — typical for rotating boards. A concrete
-- period_key (e.g. '2026-W21') overrides the wildcard for a specific period
-- (e.g. seasonal cosmetics for one week only).
--
-- reward_bundle jsonb shape:
--   [
--     { "reward_type": "calling_card", "reward_slug": "cc_xp_champion_weekly" },
--     { "reward_type": "badge",        "reward_slug": "bd_top10_xp_weekly", "tier": 1 },
--     { "reward_type": "title",        "reward_slug": "ti_xp_champion" }
--   ]
-- The RewardIssuanceService resolves slugs to ids at issue time and freezes
-- the resolved bundle into leaderboard_reward_events.reward_bundle_snapshot.

CREATE TYPE "PlacementTier" AS ENUM (
  'top_1',
  'top_3',
  'top_10'
);

CREATE TABLE leaderboard_rewards (
  id              BIGSERIAL        PRIMARY KEY,
  leaderboard_key VARCHAR(80)      NOT NULL,
  period_key      VARCHAR(20)      NOT NULL,
  placement_tier  "PlacementTier"  NOT NULL,
  reward_bundle   JSONB            NOT NULL,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CONSTRAINT leaderboard_rewards_key_period_tier_unique
    UNIQUE (leaderboard_key, period_key, placement_tier)
);

CREATE INDEX leaderboard_rewards_key_idx
  ON leaderboard_rewards (leaderboard_key, period_key);
