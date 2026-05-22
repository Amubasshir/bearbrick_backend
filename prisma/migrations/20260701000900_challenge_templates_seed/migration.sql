-- M3c Migration 8: seed initial challenge templates
-- ~13 templates covering all daily slot families + 3 weekly slots.
-- Adding new templates after launch = INSERT row, no code change.
--
-- logic_definition shape (matches ChallengeProgressService matcher):
--   { "trigger": "vote_event",           // event stream to listen on
--     "match":    { ... },               // event predicate (empty = always)
--     "count_strategy": "per_event" }    // or per_unique_brick / per_unique_category
--
-- requires_* flags are read by ImpossibilityValidator to filter at assignment.

INSERT INTO challenge_templates
  (code, display_title, description_template, challenge_family, scope,
   logic_definition, reward_xp_base, reward_xp_bonus, target_count,
   requires_contribution_access, requires_stale_targets, requires_category_target,
   requires_session_target, time_window)
VALUES
  -- ---------- daily VOTE family (3 templates so vote_1 / vote_2 pool slots get distinct picks) ----------
  ('daily_vote_5',
   'Cast 5 votes',
   'Cast 5 votes on any bricks today',
   'vote', 'daily',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_event"}'::jsonb,
   25, 0, 5, FALSE, FALSE, FALSE, FALSE, NULL),

  ('daily_vote_10',
   'Vote pacesetter',
   'Cast 10 votes on any bricks today',
   'vote', 'daily',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_event"}'::jsonb,
   50, 0, 10, FALSE, FALSE, FALSE, FALSE, NULL),

  ('daily_vote_3_unique',
   'Three unique bricks',
   'Vote on 3 different bricks today',
   'vote', 'daily',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_unique_brick"}'::jsonb,
   30, 0, 3, FALSE, FALSE, FALSE, FALSE, NULL),

  -- ---------- daily EXPLORE family ----------
  ('daily_explore_3',
   'Explorer',
   'Vote on 3 bricks you have not voted on today',
   'explore', 'daily',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_unique_brick"}'::jsonb,
   30, 0, 3, FALSE, FALSE, FALSE, FALSE, NULL),

  ('daily_explore_5',
   'Wide net',
   'Vote on 5 different bricks today',
   'explore', 'daily',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_unique_brick"}'::jsonb,
   50, 0, 5, FALSE, FALSE, FALSE, FALSE, NULL),

  -- ---------- daily MAINTAIN family ----------
  ('daily_maintain_3_stale',
   'Refresh stale prices',
   'Re-vote on 3 stale bricks today',
   'maintain', 'daily',
   '{"trigger":"vote_event","match":{"is_stale":true},"count_strategy":"per_event"}'::jsonb,
   40, 0, 3, FALSE, TRUE, FALSE, FALSE, NULL),

  ('daily_maintain_5_anyvote',
   'Steady hand',
   'Cast 5 votes on bricks needing attention',
   'maintain', 'daily',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_event"}'::jsonb,
   35, 0, 5, FALSE, FALSE, FALSE, FALSE, NULL),

  -- ---------- daily CATEGORY_MASTERY family ----------
  ('daily_category_3',
   'Category sweep',
   'Vote on bricks across 3 different categories today',
   'category_mastery', 'daily',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_unique_category"}'::jsonb,
   40, 0, 3, FALSE, FALSE, FALSE, FALSE, NULL),

  ('daily_category_5',
   'Five-flavor day',
   'Vote on bricks from 5 different categories today',
   'category_mastery', 'daily',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_unique_category"}'::jsonb,
   60, 0, 5, FALSE, FALSE, FALSE, FALSE, NULL),

  -- ---------- daily CONTRIBUTE family (gated by feature flag until contribution milestone ships) ----------
  ('daily_contribute_1_image',
   'Image contributor',
   'Submit one missing brick image',
   'contribute', 'daily',
   '{"trigger":"contribution_approved","match":{"item_type":"image"},"count_strategy":"per_event"}'::jsonb,
   75, 0, 1, TRUE, FALSE, FALSE, FALSE, NULL),

  ('daily_contribute_3_meta',
   'Metadata fixer',
   'Submit 3 metadata corrections',
   'contribute', 'daily',
   '{"trigger":"contribution_approved","match":{"item_type":"metadata"},"count_strategy":"per_event"}'::jsonb,
   60, 0, 3, TRUE, FALSE, FALSE, FALSE, NULL),

  -- ---------- WEEKLY (1 maintenance, 1 exploration, 1 wildcard-eligible) ----------
  ('weekly_maintain_15_stale',
   'Stale stalker',
   'Re-vote on 15 stale bricks this week',
   'maintain', 'weekly',
   '{"trigger":"vote_event","match":{"is_stale":true},"count_strategy":"per_event"}'::jsonb,
   150, 0, 15, FALSE, TRUE, FALSE, FALSE, NULL),

  ('weekly_explore_25',
   'Discoverer',
   'Vote on 25 different bricks this week',
   'explore', 'weekly',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_unique_brick"}'::jsonb,
   175, 0, 25, FALSE, FALSE, FALSE, FALSE, NULL),

  ('weekly_vote_50',
   'Marathoner',
   'Cast 50 votes this week',
   'vote', 'weekly',
   '{"trigger":"vote_event","match":{},"count_strategy":"per_event"}'::jsonb,
   200, 0, 50, FALSE, FALSE, FALSE, FALSE, NULL)
ON CONFLICT (code) DO NOTHING;
