-- M4 Migration 6: bounty_submissions
-- Per spec section 17.3. User submissions against a bounty instance.
-- user_id BIGINT -> "User"(id); brick_id TEXT -> bricks(id). 4-state machine.
-- Reward amounts (cash/credit/xp) are CAPTURED on the row at submission time
-- (Q5 / determinism) so later bounty_definitions edits never change a pending
-- submission's payout.

CREATE TABLE bounty_submissions (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_instance_id  UUID         NOT NULL REFERENCES bounty_instances(id),
  brick_id            TEXT         NOT NULL REFERENCES bricks(id),
  user_id             BIGINT       NOT NULL REFERENCES "User"(id),
  submission_type     TEXT         NOT NULL CHECK (submission_type IN ('IMAGE','DATA')),
  content_url         TEXT,
  content_text        TEXT,
  source_url          TEXT,
  notes               TEXT,
  status              TEXT         NOT NULL
                        CHECK (status IN ('PENDING','APPROVED','REJECTED','APPLIED_TO_BRICK'))
                        DEFAULT 'PENDING',
  rejection_reasons   TEXT[],
  admin_notes         TEXT,
  reviewed_by         BIGINT       REFERENCES "User"(id),
  reviewed_at         TIMESTAMPTZ,
  cash_reward_cents   INTEGER      NOT NULL DEFAULT 0,
  credit_reward       INTEGER      NOT NULL DEFAULT 0,
  xp_reward           INTEGER      NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX bounty_submissions_status_created_idx ON bounty_submissions (status, created_at);
CREATE INDEX bounty_submissions_user_idx           ON bounty_submissions (user_id, created_at DESC);
CREATE INDEX bounty_submissions_instance_idx       ON bounty_submissions (bounty_instance_id);
CREATE INDEX bounty_submissions_brick_idx          ON bounty_submissions (brick_id);
