-- M3d Migration 2: leaderboard_state
-- Per spec §15.2. Worker-owned derived ranking table. APIs read from here.
-- Single table with index-level slicing instead of per-board tables: at MVP
-- scale (~thousands of users × 5 boards) a single weekly slice fits well under
-- 1M rows; if we ever cross that threshold we can split later without a
-- functional change.
--
-- period_key shape:
--   'LIFETIME'    for lifetime boards (constant)
--   'YYYY-Www'    for rotating boards, e.g. '2026-W21' (UTC ISO-week per Q9)
--
-- The ranking_idx is partial (WHERE eligible = TRUE) so ineligible rows do not
-- bloat the index. Ineligible rows still exist with rank = NULL so the read
-- API can return a pinned user_row.

CREATE TABLE leaderboard_state (
  id                       BIGSERIAL      PRIMARY KEY,
  leaderboard_key          VARCHAR(80)    NOT NULL,
  period_key               VARCHAR(20)    NOT NULL,
  user_id                  BIGINT         NOT NULL REFERENCES "User"(id),
  score                    NUMERIC(18, 4) NOT NULL DEFAULT 0,
  eligible                 BOOLEAN        NOT NULL DEFAULT FALSE,
  rank                     INTEGER,
  tie_break_timestamp      TIMESTAMPTZ,
  tie_break_event_id       BIGINT,
  last_updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT leaderboard_state_key_period_user_unique
    UNIQUE (leaderboard_key, period_key, user_id)
);

CREATE INDEX leaderboard_state_rank_idx
  ON leaderboard_state (leaderboard_key, period_key, rank)
  WHERE rank IS NOT NULL;

CREATE INDEX leaderboard_state_ranking_idx
  ON leaderboard_state (
    leaderboard_key,
    period_key,
    score DESC,
    tie_break_timestamp ASC,
    tie_break_event_id ASC,
    user_id ASC
  )
  WHERE eligible = TRUE;

CREATE INDEX leaderboard_state_user_idx
  ON leaderboard_state (user_id, leaderboard_key, period_key);
