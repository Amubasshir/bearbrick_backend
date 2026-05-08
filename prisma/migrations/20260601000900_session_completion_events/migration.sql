-- M3b Migration 9: session_completion_events
-- Immutable record of every session completion (Morning 7 or Evening 11).

CREATE TABLE session_completion_events (
  id                          BIGSERIAL    PRIMARY KEY,
  user_id                     BIGINT       NOT NULL REFERENCES "User"(id),
  session_set_id              UUID         NOT NULL REFERENCES daily_session_sets(id) ON DELETE CASCADE,
  kind                        "SessionKind" NOT NULL,
  local_day_key               DATE         NOT NULL,
  streak_after_completion     INTEGER      NOT NULL,
  triggered_by_vote_event_id  BIGINT       NOT NULL REFERENCES vote_events(id),
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT session_completion_events_user_set_unique UNIQUE (user_id, session_set_id)
);

CREATE INDEX session_completion_events_user_idx
  ON session_completion_events (user_id, created_at DESC);
CREATE INDEX session_completion_events_day_kind_idx
  ON session_completion_events (local_day_key, kind);
