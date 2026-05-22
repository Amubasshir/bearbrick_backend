-- M3c Migration 9: add a second weekly MAINTAIN template that does not require
-- stale targets, so the maintenance slot is always fillable for a brand-new
-- user (and for the test environment with no brick_vote_state rows yet).
-- The stale-only template (weekly_maintain_15_stale) remains and will be
-- preferred when there are stale bricks; the seeded shuffle picks one or the
-- other deterministically per (user, week).

INSERT INTO challenge_templates
  (code, display_title, description_template, challenge_family, scope,
   logic_definition, reward_xp_base, reward_xp_bonus, target_count,
   requires_contribution_access, requires_stale_targets, requires_category_target,
   requires_session_target, time_window)
VALUES
  ('weekly_maintain_30_votes',
   'Maintainer',
   'Cast 30 votes this week to keep the market fresh',
   'maintain', 'weekly',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_event"}'::jsonb,
   150, 0, 30, FALSE, FALSE, FALSE, FALSE, NULL)
ON CONFLICT (code) DO NOTHING;
