-- M3b Migration 6: user_session_brick_counts
-- Append-only join row each time a user counts a brick toward a session set.
-- The (user_id, session_set_id, brick_id) unique constraint is the
-- double-count guard called for in the spec.

CREATE TABLE user_session_brick_counts (
  id              BIGSERIAL   PRIMARY KEY,
  user_id         BIGINT      NOT NULL REFERENCES "User"(id),
  session_set_id  UUID        NOT NULL REFERENCES daily_session_sets(id) ON DELETE CASCADE,
  brick_id        TEXT        NOT NULL REFERENCES bricks(id),
  vote_event_id   BIGINT      NOT NULL REFERENCES vote_events(id),
  counted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_session_brick_counts_unique UNIQUE (user_id, session_set_id, brick_id)
);

CREATE INDEX user_session_brick_counts_user_set_idx
  ON user_session_brick_counts (user_id, session_set_id);
