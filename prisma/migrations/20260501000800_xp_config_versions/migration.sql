-- Migration 8: xp_config_versions — versioned XP config table + seed

CREATE TABLE xp_config_versions (
  id           BIGSERIAL   PRIMARY KEY,
  version      INTEGER     NOT NULL UNIQUE,
  config       JSONB       NOT NULL,
  is_active    BOOLEAN     NOT NULL DEFAULT FALSE,
  activated_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial version from current hardcoded values in src/config/xp-levels.js
INSERT INTO xp_config_versions (version, config, is_active, activated_at) VALUES (
  1,
  '{"xpAmounts":{"vote_cast":10,"streak_bonus":25,"recheck_cast":10,"accuracy_bonus":50,"dex_stage1":100,"dex_stage3":200,"dex_streak":150},"dailyCaps":{"passive":100,"action":200,"vote":150,"contribution":500},"decayCurve":null}',
  TRUE,
  NOW()
);
