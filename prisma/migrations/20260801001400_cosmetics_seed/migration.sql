-- M3d Migration 15: cosmetics catalogue seed
-- Seeds at least 3 calling_cards, 3 badges, 2 titles, 2 flourishes with
-- is_active = TRUE so reward bundles resolve cleanly in tests and dev. These
-- are placeholders; final art and copy land via a later content-only insert.
-- Slugs are the stable public references used in leaderboard_rewards.reward_bundle.
--
-- ON CONFLICT (slug) DO NOTHING keeps the migration idempotent.

-- ── Calling cards ─────────────────────────────────────────────────────────────
INSERT INTO calling_cards (name, slug, rarity, is_hidden_until_unlocked, tiered, is_active) VALUES
  ('Weekly XP Champion',        'cc_weekly_xp_champion',        'elite',  FALSE, FALSE, TRUE),
  ('Weekly Contributor',        'cc_weekly_contributor',        'rare',   FALSE, FALSE, TRUE),
  ('Top 10 Collector',          'cc_top10_collector',           'common', FALSE, FALSE, TRUE)
ON CONFLICT (slug) DO NOTHING;

-- ── Badges ────────────────────────────────────────────────────────────────────
INSERT INTO badges (name, slug, tiered, is_active) VALUES
  ('Weekly XP Top 1',           'bd_weekly_xp_top_1',           FALSE, TRUE),
  ('Weekly XP Top 3',           'bd_weekly_xp_top_3',           FALSE, TRUE),
  ('Weekly XP Top 10',          'bd_weekly_xp_top_10',          FALSE, TRUE)
ON CONFLICT (slug) DO NOTHING;

-- ── Titles ────────────────────────────────────────────────────────────────────
INSERT INTO titles (name, slug, is_active) VALUES
  ('XP Champion',               'ti_xp_champion',               TRUE),
  ('Contribution Champion',     'ti_contribution_champion',     TRUE)
ON CONFLICT (slug) DO NOTHING;

-- ── Flourishes ────────────────────────────────────────────────────────────────
INSERT INTO flourishes (name, slug, is_active) VALUES
  ('Gold Sparkle',              'fl_gold_sparkle',              TRUE),
  ('Silver Sparkle',            'fl_silver_sparkle',            TRUE)
ON CONFLICT (slug) DO NOTHING;
