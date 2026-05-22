-- M3c Migration 6: challenge_assignment_log
-- Lightweight debug log of why each template was selected / filtered / used as
-- fallback during assignment. Not on the hot path. Helps explain "where are
-- my challenges" without polluting user_challenge_assignments.

CREATE TABLE challenge_assignment_log (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         BIGINT       NOT NULL,
  template_id     BIGINT       NOT NULL,
  assignment_date DATE         NOT NULL,
  decision        TEXT         NOT NULL,
  reason_detail   JSONB,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX challenge_assignment_log_user_date_idx
  ON challenge_assignment_log (user_id, assignment_date);
