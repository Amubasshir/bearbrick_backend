-- M3d Migration 9: flourishes
-- Per spec §14.3. Cosmetic catalogue for flourishes (visual accents). Not
-- equipped via a dedicated User column at MVP — flourishes are owned via
-- user_rewards and surfaced in profile UI later. Schema matches the other
-- cosmetic catalogues for consistency.

CREATE TABLE flourishes (
  id         BIGSERIAL    PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  slug       VARCHAR(120) NOT NULL UNIQUE,
  asset_ref  TEXT,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX flourishes_active_idx ON flourishes (is_active);
