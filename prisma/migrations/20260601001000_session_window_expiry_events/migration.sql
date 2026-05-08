-- M3b Migration 10: session_window_expiry_events
-- Immutable. Logged when a session window passes without completion.

CREATE TABLE session_window_expiry_events (
  id                       BIGSERIAL    PRIMARY KEY,
  user_id                  BIGINT       NOT NULL REFERENCES "User"(id),
  session_set_id           UUID         NOT NULL REFERENCES daily_session_sets(id) ON DELETE CASCADE,
  kind                     "SessionKind" NOT NULL,
  local_day_key            DATE         NOT NULL,
  partial_count_at_expiry  INTEGER      NOT NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT session_window_expiry_events_unique UNIQUE (user_id, session_set_id)
);

CREATE INDEX session_window_expiry_events_user_idx
  ON session_window_expiry_events (user_id, created_at DESC);
