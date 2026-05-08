-- Migration 1: Expand xp_events for M3a

-- 1a. Make brick_id nullable (new event types are not brick-specific)
ALTER TABLE xp_events ALTER COLUMN brick_id DROP NOT NULL;

-- 1b. Add M3a columns with temporary defaults for backfill
ALTER TABLE xp_events
  ADD COLUMN xp_delta_signed  INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN event_type       VARCHAR(64)  NOT NULL DEFAULT 'legacy',
  ADD COLUMN source_system    VARCHAR(64)  NOT NULL DEFAULT 'phase2',
  ADD COLUMN xp_confirmed     BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN local_day_key    DATE         NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN idempotency_key  VARCHAR(255),
  ADD COLUMN metadata         JSONB;

-- 1c. Backfill from existing rows
UPDATE xp_events SET
  xp_delta_signed = xp_amount,
  event_type = CASE reason
    WHEN 'VOTE'       THEN 'vote_cast'
    WHEN 'STREAK'     THEN 'streak_bonus'
    WHEN 'RECHECK'    THEN 'recheck_cast'
    WHEN 'ACCURACY'   THEN 'accuracy_bonus'
    WHEN 'DEX_STAGE1' THEN 'dex_stage1'
    WHEN 'DEX_STAGE3' THEN 'dex_stage3'
    WHEN 'DEX_STREAK' THEN 'dex_streak'
    ELSE 'legacy'
  END,
  local_day_key   = "createdAt"::DATE,
  idempotency_key = 'legacy:xp:' || id::TEXT;

-- 1d. Remove temporary DEFAULT placeholders now that all rows are backfilled
ALTER TABLE xp_events
  ALTER COLUMN xp_delta_signed DROP DEFAULT,
  ALTER COLUMN event_type      DROP DEFAULT,
  ALTER COLUMN source_system   DROP DEFAULT,
  ALTER COLUMN local_day_key   DROP DEFAULT;

-- 1e. Partial unique index: idempotency_key must be unique when present
CREATE UNIQUE INDEX xp_events_idempotency_key_unique
  ON xp_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 1f. Index for worker cursor queries (confirmed events only)
CREATE INDEX xp_events_confirmed_cursor_idx
  ON xp_events (id ASC)
  WHERE xp_confirmed = TRUE;
