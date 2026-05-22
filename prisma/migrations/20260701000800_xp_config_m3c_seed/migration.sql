-- M3c Migration 7: xp_config_versions — version 3 with M3c additions
-- M3a seeded version 1, M3b seeded version 2 (added session completion XP).
-- M3c adds challenge XP amounts, daily/weekly mix config, and the
-- contribution feature flag. Existing M3a/M3b keys are preserved verbatim
-- (streak_bonus stays at 5 — M3b's actual seeded value, NOT the 25 in spec).
-- All M3a/M3b code uses ORDER BY version DESC LIMIT 1 so it picks up v3 with
-- no code change.

INSERT INTO xp_config_versions (version, config, is_active, activated_at) VALUES (
  3,
  '{
    "xpAmounts": {
      "vote_cast": 10,
      "streak_bonus": 5,
      "recheck_cast": 10,
      "accuracy_bonus": 50,
      "dex_stage1": 100,
      "dex_stage3": 200,
      "dex_streak": 150,
      "session_completion_morning": 50,
      "session_completion_evening": 75,
      "all_five_dailies_bonus": 100,
      "perfect_day_bonus": 250
    },
    "dailyCaps": {
      "passive": 100,
      "action": 200,
      "vote": 150,
      "contribution": 500
    },
    "decayCurve": null,
    "challenges": {
      "daily_assignment_count": 5,
      "weekly_assignment_count": 3,
      "max_session_overlap": 2,
      "daily_pool_family_mix": {
        "vote_1": "vote",
        "vote_2": "vote",
        "explore": "explore",
        "maintain": "maintain",
        "category_mastery": "category_mastery",
        "contribute": "contribute",
        "wildcard": "*"
      },
      "weekly_slate_mix": {
        "maintenance": "maintain",
        "exploration": "explore",
        "wildcard": "*"
      }
    },
    "featureFlags": {
      "contribution_system_enabled": false
    }
  }'::jsonb,
  TRUE,
  NOW()
)
ON CONFLICT (version) DO NOTHING;

UPDATE xp_config_versions SET is_active = FALSE WHERE version <> 3;
UPDATE xp_config_versions SET is_active = TRUE  WHERE version = 3;
