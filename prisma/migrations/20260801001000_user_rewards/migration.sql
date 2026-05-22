-- M3d Migration 11: user_rewards
-- Per spec §14.5. Generic polymorphic ownership table linking users to earned
-- cosmetics. reward_id is a BIGINT pointing into the catalogue table named by
-- reward_type — FK enforced in application code rather than via SQL because
-- Postgres has no clean way to model polymorphic FKs. The (reward_type,
-- reward_id) integrity is validated by RewardIssuanceService at insert time.
--
-- source_type / source_id track provenance: 'leaderboard' / '<period_key>'
-- for M3d issuances. Future systems (secrets, milestones, admin grants) can
-- use the same table without schema change.
--
-- Uniqueness via COALESCE(tier, 0) is the standard Postgres pattern for
-- "null-safe uniqueness across nullable column", ensuring a user can't earn
-- the same cosmetic twice at the same tier (and a non-tiered cosmetic only
-- once total, since tier is always NULL→0).

CREATE TYPE "RewardType" AS ENUM (
  'calling_card',
  'badge',
  'flourish',
  'title'
);

CREATE TYPE "RewardSource" AS ENUM (
  'leaderboard',
  'milestone',
  'secret',
  'admin_grant',
  'migration'
);

CREATE TABLE user_rewards (
  id          BIGSERIAL       PRIMARY KEY,
  user_id     BIGINT          NOT NULL REFERENCES "User"(id),
  reward_type "RewardType"    NOT NULL,
  reward_id   BIGINT          NOT NULL,
  tier        INTEGER,
  source_type "RewardSource"  NOT NULL,
  source_id   VARCHAR(120),
  unlocked_at TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  CONSTRAINT user_rewards_tier_nonneg CHECK (tier IS NULL OR tier >= 0)
);

CREATE UNIQUE INDEX user_rewards_ownership_unique_idx
  ON user_rewards (user_id, reward_type, reward_id, COALESCE(tier, 0));

CREATE INDEX user_rewards_user_type_idx ON user_rewards (user_id, reward_type);
CREATE INDEX user_rewards_source_idx
  ON user_rewards (source_type, source_id);
