-- M3d Migration 1: leaderboard_definitions
-- Per spec §15.1. Database-driven catalogue of leaderboards. Adding a new board
-- after launch = inserting a row; the worker discovers it on its next tick via
-- LeaderboardDefinitionService.listActive(). Eligibility thresholds live in
-- the eligibility_rule jsonb (per spec §22), so tuning a min-level cutoff is
-- a config-only change. period_definition tells the worker how to derive the
-- period_key (NULL for lifetime, {"generator":"utc_iso_week"} for rotating).

CREATE TYPE "LeaderboardScope" AS ENUM (
  'lifetime',
  'weekly',
  'monthly'
);

CREATE TYPE "LeaderboardMetricType" AS ENUM (
  'collector_xp',
  'approved_contribution_weight',
  'dex_completion_percent'
);

CREATE TYPE "LeaderboardTieBreakRule" AS ENUM (
  'earliest_to_score'
);

CREATE TABLE leaderboard_definitions (
  id                            BIGSERIAL                  PRIMARY KEY,
  leaderboard_key               VARCHAR(80)                NOT NULL UNIQUE,
  scope                         "LeaderboardScope"         NOT NULL,
  metric_type                   "LeaderboardMetricType"    NOT NULL,
  eligibility_rule              JSONB                      NOT NULL DEFAULT '{}'::jsonb,
  tie_break_rule                "LeaderboardTieBreakRule"  NOT NULL DEFAULT 'earliest_to_score',
  reward_enabled                BOOLEAN                    NOT NULL DEFAULT FALSE,
  period_definition             JSONB,
  anti_sniping_window_seconds   INTEGER,
  is_active                     BOOLEAN                    NOT NULL DEFAULT TRUE,
  logic_version                 VARCHAR(32)                NOT NULL DEFAULT 'm3d_v1',
  created_at                    TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  CONSTRAINT leaderboard_definitions_lifetime_no_period CHECK (
    (scope = 'lifetime' AND period_definition IS NULL AND anti_sniping_window_seconds IS NULL)
 OR (scope <> 'lifetime')
  ),
  CONSTRAINT leaderboard_definitions_anti_sniping_nonneg CHECK (
    anti_sniping_window_seconds IS NULL OR anti_sniping_window_seconds >= 0
  )
);

CREATE INDEX leaderboard_definitions_active_idx
  ON leaderboard_definitions (is_active);
CREATE INDEX leaderboard_definitions_scope_active_idx
  ON leaderboard_definitions (scope, is_active);
