-- M3b Migration 11: streak_break_events
-- Immutable. Recorded when a streak resets to 0 via missed-day detection.
-- UI never shows negative framing — this is for replay/audit only.

CREATE TABLE streak_break_events (
  id             BIGSERIAL    PRIMARY KEY,
  user_id        BIGINT       NOT NULL REFERENCES "User"(id),
  kind           "SessionKind" NOT NULL,
  from_streak    INTEGER      NOT NULL,
  local_day_key  DATE         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX streak_break_events_user_idx
  ON streak_break_events (user_id, created_at DESC);
