-- M3b Migration 7: user_streak_state
-- Worker-owned. Morning and Evening streaks tracked completely independently.

CREATE TABLE user_streak_state (
  user_id                          BIGINT      PRIMARY KEY REFERENCES "User"(id),
  morning_streak                   INTEGER     NOT NULL DEFAULT 0,
  morning_last_completed_local_day DATE,
  morning_longest                  INTEGER     NOT NULL DEFAULT 0,
  evening_streak                   INTEGER     NOT NULL DEFAULT 0,
  evening_last_completed_local_day DATE,
  evening_longest                  INTEGER     NOT NULL DEFAULT 0,
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
