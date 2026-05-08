-- M3b Migration 1: User.timezone
-- IANA timezone string used by every local_day_key + session window computation.

ALTER TABLE "User"
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
