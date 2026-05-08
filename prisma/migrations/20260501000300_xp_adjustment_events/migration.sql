-- Migration 3: xp_adjustment_events — correction ledger

CREATE TABLE xp_adjustment_events (
  id                   BIGSERIAL    PRIMARY KEY,
  user_id              BIGINT       NOT NULL REFERENCES "User"(id),
  original_xp_event_id BIGINT       REFERENCES xp_events(id),
  xp_delta_signed      INTEGER      NOT NULL,
  reason               TEXT         NOT NULL,
  created_by           VARCHAR(128) NOT NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  metadata             JSONB
);

CREATE INDEX xp_adjustment_events_user_idx
  ON xp_adjustment_events (user_id, created_at DESC);
