-- M3d Migration 7: calling_cards
-- Per spec §14.1. Cosmetic catalogue. Adding a new calling card after launch =
-- inserting a row; no code change. The slug is the stable public reference
-- used in leaderboard_rewards.reward_bundle JSON.
--
-- rarity is a free-form text ('common', 'rare', 'elite', etc.) so reveal UX
-- (toast vs slide-in vs modal per spec §7.6) can be tuned in product later
-- without a schema change. tiered=TRUE means the card has multiple visual
-- tiers (e.g. bronze/silver/gold) addressed by user_rewards.tier.

CREATE TABLE calling_cards (
  id                       BIGSERIAL    PRIMARY KEY,
  name                     VARCHAR(120) NOT NULL,
  slug                     VARCHAR(120) NOT NULL UNIQUE,
  rarity                   VARCHAR(32)  NOT NULL DEFAULT 'common',
  is_hidden_until_unlocked BOOLEAN      NOT NULL DEFAULT FALSE,
  tiered                   BOOLEAN      NOT NULL DEFAULT FALSE,
  asset_ref                TEXT,
  is_active                BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX calling_cards_active_idx ON calling_cards (is_active);
