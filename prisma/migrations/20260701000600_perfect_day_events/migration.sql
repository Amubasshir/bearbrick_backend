-- M3c Migration 5: perfect_day_events
-- Per spec §11.5 and Q3. Event-driven (not cron). Idempotency key shape is
-- strictly "perfect_day:{user_id}:{local_day_key}" per Q3 canonical answer.
-- Crossing midnight does NOT split the logical day — the local_day_key drives
-- everything, calendar date is never used.

CREATE TABLE perfect_day_events (
  id                     BIGSERIAL    PRIMARY KEY,
  user_id                BIGINT       NOT NULL REFERENCES "User"(id),
  local_date             DATE         NOT NULL,
  morning_completed      BOOLEAN      NOT NULL,
  evening_completed      BOOLEAN      NOT NULL,
  all_dailies_completed  BOOLEAN      NOT NULL,
  perfect_day_awarded    BOOLEAN      NOT NULL DEFAULT TRUE,
  idempotency_key        VARCHAR(255) NOT NULL UNIQUE,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT perfect_day_events_user_date_unique UNIQUE (user_id, local_date)
);

CREATE INDEX perfect_day_events_user_created_idx
  ON perfect_day_events (user_id, created_at DESC);
