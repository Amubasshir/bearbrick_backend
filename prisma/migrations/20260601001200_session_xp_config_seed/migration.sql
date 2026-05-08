-- M3b Migration 12: extend xp_config_versions with session XP values
-- Adds session_completion (Morning/Evening) and streak_bonus values.
-- Mirrors M3a precedent: keep XpReason enum stable; identify via event_type string.

INSERT INTO xp_config_versions (version, config, is_active, activated_at)
VALUES (
  2,
  '{"xpAmounts":{"vote_cast":10,"streak_bonus":5,"recheck_cast":10,"accuracy_bonus":50,"dex_stage1":100,"dex_stage3":200,"dex_streak":150,"session_completion_morning":50,"session_completion_evening":75},"dailyCaps":{"passive":100,"action":200,"vote":150,"contribution":500},"decayCurve":null}',
  TRUE,
  NOW()
)
ON CONFLICT (version) DO NOTHING;

-- Deactivate prior versions so only the newest is active
UPDATE xp_config_versions SET is_active = FALSE WHERE version <> 2;
UPDATE xp_config_versions SET is_active = TRUE  WHERE version = 2;
