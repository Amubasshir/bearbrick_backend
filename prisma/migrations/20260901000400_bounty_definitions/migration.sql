-- M4 Migration 4: bounty_definitions (+ seed of the 8 MVP types)
-- Per spec section 17.1. Global catalogue of bounty types and reward amounts.
-- Adding/retuning a bounty type post-launch = a row insert/update (config-only).
-- is_active = FALSE globally pauses a type (admin pause-by-type, Q19).
-- Seeded amounts come straight from the spec section 3 reward table.
-- Own PK is UUID (per spec); only user/brick FKs were corrected to BIGINT/TEXT.

CREATE TABLE bounty_definitions (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  type               TEXT         NOT NULL UNIQUE,
  display_name       TEXT         NOT NULL,
  description        TEXT,
  reward_cash_cents  INTEGER      NOT NULL DEFAULT 0,
  reward_credits     INTEGER      NOT NULL DEFAULT 0,
  priority           TEXT         NOT NULL CHECK (priority IN ('LOW','MEDIUM','HIGH')),
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO bounty_definitions
  (type, display_name, description, reward_cash_cents, reward_credits, priority) VALUES
  ('PACKAGING_FRONT', 'Packaging Front', 'Shows the front panel of the packaging',  50, 50, 'HIGH'),
  ('PACKAGING_BACK',  'Packaging Back',  'Shows the full back panel of packaging',  75, 75, 'HIGH'),
  ('BACK_OF_FIGURE',  'Back of Figure',  'Shows the back of the figure',            40, 40, 'HIGH'),
  ('SIDE_VIEW',       'Side View',       'Shows the side profile of the figure',    25, 25, 'MEDIUM'),
  ('BOTTOM_STAMP',    'Bottom Stamp',    'Shows the bottom / foot stamp',           50, 50, 'HIGH'),
  ('RELEASE_YEAR',    'Release Year',    'Confirm the release year',                15, 15, 'MEDIUM'),
  ('RELEASE_METHOD',  'Release Method',  'Confirm how this was released',           25, 25, 'MEDIUM'),
  ('NOTES_CONTEXT',   'Notes / Context', 'Add notes or context for this figure',    25, 25, 'MEDIUM')
ON CONFLICT (type) DO NOTHING;
