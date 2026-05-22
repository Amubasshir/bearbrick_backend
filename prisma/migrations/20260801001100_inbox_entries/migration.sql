-- M3d Migration 12: inbox_entries
-- Per spec §16.1. User-facing notification inbox. M3d writes only
-- 'leaderboard_reward' entries via RewardIssuanceService. The other enum
-- values (level_up, contribution_approved, contribution_rejected,
-- daily_completed, weekly_completed, perfect_day, streak_broken,
-- system_notice) are reserved for forward compatibility; M3a/M3b/M3c
-- workers are NOT modified in M3d.
--
-- metadata jsonb carries optional structured payload (e.g. for a leaderboard
-- reward: { "leaderboard_key": "...", "period_key": "2026-W21",
-- "placement_tier": "top_3", "reward_bundle": [...] }).

CREATE TYPE "InboxEntryType" AS ENUM (
  'level_up',
  'contribution_approved',
  'contribution_rejected',
  'daily_completed',
  'weekly_completed',
  'perfect_day',
  'leaderboard_reward',
  'streak_broken',
  'system_notice'
);

CREATE TABLE inbox_entries (
  id             BIGSERIAL          PRIMARY KEY,
  user_id        BIGINT             NOT NULL REFERENCES "User"(id),
  entry_type     "InboxEntryType"   NOT NULL,
  title          VARCHAR(200)       NOT NULL,
  body           TEXT,
  reference_type VARCHAR(60),
  reference_id   VARCHAR(120),
  metadata       JSONB              NOT NULL DEFAULT '{}'::jsonb,
  is_read        BOOLEAN            NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE INDEX inbox_entries_user_created_idx
  ON inbox_entries (user_id, created_at DESC);
CREATE INDEX inbox_entries_user_unread_idx
  ON inbox_entries (user_id) WHERE is_read = FALSE;
CREATE INDEX inbox_entries_reference_idx
  ON inbox_entries (reference_type, reference_id);
