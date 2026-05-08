-- M3b Migration 5: user_session_progress
-- Per-user per-session-set progress counter. Worker-owned.

CREATE TABLE user_session_progress (
  user_id        BIGINT      NOT NULL REFERENCES "User"(id),
  session_set_id UUID        NOT NULL REFERENCES daily_session_sets(id) ON DELETE CASCADE,
  partial_count  INTEGER     NOT NULL DEFAULT 0,
  target_count   INTEGER     NOT NULL,
  completed_at   TIMESTAMPTZ,
  expired_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, session_set_id)
);

CREATE INDEX user_session_progress_set_idx
  ON user_session_progress (session_set_id);
CREATE INDEX user_session_progress_pending_expiry_idx
  ON user_session_progress (expired_at, completed_at)
  WHERE expired_at IS NULL AND completed_at IS NULL;
