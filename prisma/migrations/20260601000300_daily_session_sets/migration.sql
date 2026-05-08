-- M3b Migration 3: daily_session_sets + SessionKind enum
-- One row per (local_day_key, kind). Race-safe JIT insert relies on the unique.

CREATE TYPE "SessionKind" AS ENUM ('MORNING', 'EVENING');

CREATE TABLE daily_session_sets (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  local_day_key      DATE         NOT NULL,
  kind               "SessionKind" NOT NULL,
  rotation_cycle_id  UUID         NOT NULL REFERENCES session_rotation_cycles(id),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT daily_session_sets_day_kind_unique UNIQUE (local_day_key, kind)
);

CREATE INDEX daily_session_sets_cycle_idx
  ON daily_session_sets (rotation_cycle_id);
