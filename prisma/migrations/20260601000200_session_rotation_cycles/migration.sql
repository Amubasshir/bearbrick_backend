-- M3b Migration 2: session_rotation_cycles
-- One row per global rotation pool. New row when previous pool exhausted.

CREATE TABLE session_rotation_cycles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  pool_size   INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX session_rotation_cycles_active_idx
  ON session_rotation_cycles (started_at)
  WHERE ended_at IS NULL;
