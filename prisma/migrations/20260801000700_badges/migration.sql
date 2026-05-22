-- M3d Migration 8: badges
-- Per spec §14.2. Cosmetic catalogue for badges. Equipped via the User
-- equipped_badge_slot_1/2/3 columns (added in migration 20260801001200).
-- tiered=TRUE means the badge has progression tiers (e.g. Bronze→Silver→Gold)
-- addressed by user_rewards.tier.

CREATE TABLE badges (
  id         BIGSERIAL    PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  slug       VARCHAR(120) NOT NULL UNIQUE,
  tiered     BOOLEAN      NOT NULL DEFAULT FALSE,
  asset_ref  TEXT,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX badges_active_idx ON badges (is_active);
