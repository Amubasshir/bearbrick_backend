-- Migration 6: xp_idempotency_keys — O(1) duplicate-grant prevention

CREATE TABLE xp_idempotency_keys (
  key         VARCHAR(255) PRIMARY KEY,
  user_id     BIGINT       NOT NULL REFERENCES "User"(id),
  xp_event_id BIGINT       REFERENCES xp_events(id),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX xp_idempotency_keys_user_idx
  ON xp_idempotency_keys (user_id);

-- Backfill from legacy xp_events that already have idempotency_key set
INSERT INTO xp_idempotency_keys (key, user_id, xp_event_id, created_at)
SELECT idempotency_key, user_id, id, "createdAt"
FROM xp_events
WHERE idempotency_key IS NOT NULL
ON CONFLICT (key) DO NOTHING;
