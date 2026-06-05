-- M4 Migration 5: bounty_instances (+ unique_open_bounty partial index)
-- Per spec section 17.2. A specific bounty attached to a specific brick + target
-- field. brick_id is TEXT (bricks.id is uuid-as-text in this codebase, not native
-- uuid). The partial unique index enforces "at most one OPEN bounty per (brick,
-- type, field)" so re-generation is idempotent via ON CONFLICT DO NOTHING.
-- (Partial uniques cannot be expressed in schema.prisma; kept SQL-only, like the
-- existing bricks.search_tsv generated column.)

CREATE TABLE bounty_instances (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  brick_id              TEXT         NOT NULL REFERENCES bricks(id),
  bounty_definition_id  UUID         NOT NULL REFERENCES bounty_definitions(id),
  target_field          TEXT         NOT NULL,
  status                TEXT         NOT NULL CHECK (status IN ('OPEN','CLOSED','PAUSED')) DEFAULT 'OPEN',
  created_by            TEXT         NOT NULL DEFAULT 'SYSTEM',
  closed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX unique_open_bounty
  ON bounty_instances (brick_id, bounty_definition_id, target_field)
  WHERE status = 'OPEN';

CREATE INDEX bounty_instances_brick_status_idx ON bounty_instances (brick_id, status);
CREATE INDEX bounty_instances_status_idx       ON bounty_instances (status);
