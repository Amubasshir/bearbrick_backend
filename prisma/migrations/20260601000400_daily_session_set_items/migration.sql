-- M3b Migration 4: daily_session_set_items
-- Brick membership in a session set. rotation_cycle_id is denormalized so we
-- can enforce "no brick reuse before reshuffle" with a direct unique.

CREATE TABLE daily_session_set_items (
  session_set_id     UUID        NOT NULL REFERENCES daily_session_sets(id) ON DELETE CASCADE,
  brick_id           TEXT        NOT NULL REFERENCES bricks(id),
  slot_index         INTEGER     NOT NULL,
  rotation_cycle_id  UUID        NOT NULL REFERENCES session_rotation_cycles(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_set_id, brick_id),
  CONSTRAINT daily_session_set_items_cycle_brick_unique
    UNIQUE (rotation_cycle_id, brick_id)
);

CREATE INDEX daily_session_set_items_set_idx
  ON daily_session_set_items (session_set_id, slot_index);
CREATE INDEX daily_session_set_items_brick_idx
  ON daily_session_set_items (brick_id);
