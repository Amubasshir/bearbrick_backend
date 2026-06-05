-- M4 Migration 10: user_bounty_stats
-- Per spec section 17.7. Per-user contribution counters + daily submission limit
-- state. daily_submission_count resets at 5 AM local (UTC fallback) -- lazily on
-- read in BountySubmissionService and swept by the daily-submission-counter-reset
-- worker. approval_rate = accepted / total_reviewed (pending excluded, section 13.2).

CREATE TABLE user_bounty_stats (
  user_id                   BIGINT        PRIMARY KEY REFERENCES "User"(id),
  total_submissions         INTEGER       NOT NULL DEFAULT 0,
  pending_submissions       INTEGER       NOT NULL DEFAULT 0,
  accepted_submissions      INTEGER       NOT NULL DEFAULT 0,
  rejected_submissions      INTEGER       NOT NULL DEFAULT 0,
  approval_rate             NUMERIC(5,2)  NOT NULL DEFAULT 0,
  daily_submission_count    INTEGER       NOT NULL DEFAULT 0,
  daily_submission_limit    INTEGER       NOT NULL DEFAULT 10,
  daily_submission_reset_at TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
