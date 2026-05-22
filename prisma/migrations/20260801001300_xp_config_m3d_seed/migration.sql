-- M3d Migration 14: xp_config_versions — version 4 with M3d additions
-- M3a seeded v1, M3b seeded v2, M3c seeded v3. M3d adds a 'leaderboard' block
-- and a 'leaderboard_rewards_enabled' feature flag. Everything else is copied
-- VERBATIM from v3 so M3a/M3b/M3c code paths (which read the active version)
-- see no behavioural change.
--
-- v3 stays intact for replay safety (per spec §11.4-6 / Q11). Existing
-- xp_events that referenced v3 will continue to replay identically.

INSERT INTO xp_config_versions (version, config, is_active, activated_at) VALUES (
  4,
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
      "contribution_system_enabled": false,
      "leaderboard_rewards_enabled": true
    },
    "leaderboard": {
      "default_anti_sniping_window_seconds": 300,
      "top_snapshot_size": 10,
      "eligibility_defaults": {
        "min_level": 3,
        "min_weekly_actions": 5,
        "min_lifetime_xp": 100
      },
      "around_me_window": 5
    }
  }'::jsonb,
  TRUE,
  NOW()
)
ON CONFLICT (version) DO NOTHING;

UPDATE xp_config_versions SET is_active = FALSE WHERE version <> 4;
UPDATE xp_config_versions SET is_active = TRUE  WHERE version = 4;
