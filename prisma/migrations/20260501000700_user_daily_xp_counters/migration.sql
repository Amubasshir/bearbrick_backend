-- Migration 7: user_daily_xp_counters — per-user daily cap buckets

CREATE TABLE user_daily_xp_counters (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES "User"(id),
  local_day_key DATE        NOT NULL,
  xp_type       VARCHAR(64) NOT NULL,
  xp_total      INTEGER     NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, local_day_key, xp_type)
);

CREATE INDEX user_daily_xp_counters_lookup_idx
  ON user_daily_xp_counters (user_id, local_day_key);
