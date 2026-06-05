-- M4 Migration 3: User auth-foundation fields for the bounty milestone
-- Decision D1 (minimal): is_admin and email_verified_at already exist on "User",
-- so only the still-missing columns are added here. The richer role enum +
-- permission_overrides are deferred to the dedicated auth milestone.
--   - account_state: gates bounty submission (read_only/suspended/banned block).
--   - paypal_handle / venmo_handle: profile-default payout handles (Q8), editable
--     per request in Phase B.

CREATE TYPE "AccountState" AS ENUM (
  'active',
  'email_unverified',
  'read_only',
  'suspended_temporary',
  'banned_permanent'
);

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS account_state "AccountState" NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS paypal_handle TEXT,
  ADD COLUMN IF NOT EXISTS venmo_handle  TEXT;
