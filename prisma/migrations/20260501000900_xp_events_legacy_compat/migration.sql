-- Migration 9: Restore column defaults for backwards-compatibility with XpService.js
-- XpService creates xp_events without the new M3a fields; these defaults
-- ensure existing inserts continue to work without modifying XpService.

ALTER TABLE xp_events
  ALTER COLUMN xp_delta_signed SET DEFAULT 0,
  ALTER COLUMN event_type      SET DEFAULT 'legacy',
  ALTER COLUMN source_system   SET DEFAULT 'phase2',
  ALTER COLUMN local_day_key   SET DEFAULT CURRENT_DATE;

-- Trigger: when xp_delta_signed arrives as 0 (i.e. XpService did not supply it),
-- copy from xp_amount so the reconciliation worker sees the correct value.
CREATE OR REPLACE FUNCTION xp_events_sync_delta()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.xp_delta_signed = 0 THEN
    NEW.xp_delta_signed := NEW.xp_amount;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER xp_events_sync_delta_trigger
  BEFORE INSERT ON xp_events
  FOR EACH ROW EXECUTE FUNCTION xp_events_sync_delta();
