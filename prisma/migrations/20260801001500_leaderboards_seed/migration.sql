-- M3d Migration 16: leaderboard_definitions + leaderboard_rewards seed
-- Seeds the five MVP boards per the plan:
--   Lifetime (reward_enabled = FALSE at MVP):
--     - lifetime_collector_xp          (metric: collector_xp)
--     - lifetime_contribution_weighted (metric: approved_contribution_weight) [score stub]
--     - lifetime_dex_completion        (metric: dex_completion_percent)
--   Rotating (reward_enabled = TRUE, 300s anti-sniping window):
--     - weekly_collector_xp            (metric: collector_xp)
--     - weekly_contribution_weighted   (metric: approved_contribution_weight) [score stub]
--
-- Eligibility rules use the v4 defaults from xp_config_versions.leaderboard
-- as fallbacks (LeaderboardDefinitionService merges them at read time). The
-- per-row eligibility_rule jsonb only overrides what differs from defaults.
--
-- leaderboard_rewards rows use period_key = '*' to mean "every period of this
-- board" — concrete period_keys can override later for seasonal cosmetics.
--
-- ON CONFLICT (leaderboard_key) / (lb_key, period_key, tier) keeps it idempotent.

-- ── Leaderboard definitions ───────────────────────────────────────────────────

INSERT INTO leaderboard_definitions (
  leaderboard_key, scope, metric_type, eligibility_rule, reward_enabled,
  period_definition, anti_sniping_window_seconds, is_active, logic_version
) VALUES
  (
    'lifetime_collector_xp', 'lifetime', 'collector_xp',
    '{"min_lifetime_xp": 100}'::jsonb,
    FALSE,
    NULL,
    NULL,
    TRUE,
    'm3d_v1'
  ),
  (
    'lifetime_contribution_weighted', 'lifetime', 'approved_contribution_weight',
    '{"min_approved_contributions": 1}'::jsonb,
    FALSE,
    NULL,
    NULL,
    TRUE,
    'm3d_v1'
  ),
  (
    'lifetime_dex_completion', 'lifetime', 'dex_completion_percent',
    '{"min_dex_completion_pct": 1}'::jsonb,
    FALSE,
    NULL,
    NULL,
    TRUE,
    'm3d_v1'
  ),
  (
    'weekly_collector_xp', 'weekly', 'collector_xp',
    '{"min_level": 3, "min_weekly_actions": 5}'::jsonb,
    TRUE,
    '{"generator": "utc_iso_week"}'::jsonb,
    300,
    TRUE,
    'm3d_v1'
  ),
  (
    'weekly_contribution_weighted', 'weekly', 'approved_contribution_weight',
    '{"min_approved_contributions": 1}'::jsonb,
    TRUE,
    '{"generator": "utc_iso_week"}'::jsonb,
    300,
    TRUE,
    'm3d_v1'
  )
ON CONFLICT (leaderboard_key) DO NOTHING;

-- ── Leaderboard rewards (weekly boards only) ──────────────────────────────────
-- weekly_collector_xp
INSERT INTO leaderboard_rewards (leaderboard_key, period_key, placement_tier, reward_bundle) VALUES
  (
    'weekly_collector_xp', '*', 'top_1',
    '[
      {"reward_type": "calling_card", "reward_slug": "cc_weekly_xp_champion"},
      {"reward_type": "badge",        "reward_slug": "bd_weekly_xp_top_1"},
      {"reward_type": "title",        "reward_slug": "ti_xp_champion"},
      {"reward_type": "flourish",     "reward_slug": "fl_gold_sparkle"}
    ]'::jsonb
  ),
  (
    'weekly_collector_xp', '*', 'top_3',
    '[
      {"reward_type": "badge",    "reward_slug": "bd_weekly_xp_top_3"},
      {"reward_type": "flourish", "reward_slug": "fl_silver_sparkle"}
    ]'::jsonb
  ),
  (
    'weekly_collector_xp', '*', 'top_10',
    '[
      {"reward_type": "badge", "reward_slug": "bd_weekly_xp_top_10"}
    ]'::jsonb
  ),
  -- weekly_contribution_weighted
  (
    'weekly_contribution_weighted', '*', 'top_1',
    '[
      {"reward_type": "calling_card", "reward_slug": "cc_weekly_contributor"},
      {"reward_type": "title",        "reward_slug": "ti_contribution_champion"},
      {"reward_type": "flourish",     "reward_slug": "fl_gold_sparkle"}
    ]'::jsonb
  ),
  (
    'weekly_contribution_weighted', '*', 'top_3',
    '[
      {"reward_type": "calling_card", "reward_slug": "cc_top10_collector"},
      {"reward_type": "flourish",     "reward_slug": "fl_silver_sparkle"}
    ]'::jsonb
  ),
  (
    'weekly_contribution_weighted', '*', 'top_10',
    '[
      {"reward_type": "calling_card", "reward_slug": "cc_top10_collector"}
    ]'::jsonb
  )
ON CONFLICT (leaderboard_key, period_key, placement_tier) DO NOTHING;
