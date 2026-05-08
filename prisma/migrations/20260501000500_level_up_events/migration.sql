-- Migration 5: level_up_events — immutable level transition ledger

CREATE TABLE level_up_events (
  id                       BIGSERIAL   PRIMARY KEY,
  user_id                  BIGINT      NOT NULL REFERENCES "User"(id),
  from_level               INTEGER     NOT NULL,
  to_level                 INTEGER     NOT NULL,
  triggered_by_xp_event_id BIGINT      REFERENCES xp_events(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX level_up_events_user_idx
  ON level_up_events (user_id, created_at DESC);
