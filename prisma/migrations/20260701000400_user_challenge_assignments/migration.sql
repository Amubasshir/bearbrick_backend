-- M3c Migration 3: user_challenge_assignments
-- Per spec §11.3. Daily assignments are 5 per user per local_day_key, drawn
-- from the global daily pool of 7 via ImpossibilityValidator + selectFive.
-- Weekly assignments are 3 per user per local Monday key, drawn directly from
-- challenge_templates (no weekly pool table — see plan, decided per timezone
-- mismatch concern in Q9 / weekly local time spec).

CREATE TYPE "WeeklySlotType" AS ENUM (
  'maintenance',
  'exploration',
  'wildcard'
);

CREATE TYPE "AssignmentStatus" AS ENUM (
  'assigned',
  'completed',
  'expired'
);

CREATE TABLE user_challenge_assignments (
  id                       BIGSERIAL           PRIMARY KEY,
  user_id                  BIGINT              NOT NULL REFERENCES "User"(id),
  template_id              BIGINT              NOT NULL REFERENCES challenge_templates(id),
  scope                    "ChallengeScope"    NOT NULL,
  assignment_date          DATE,
  assignment_week_key      DATE,
  weekly_slot_type         "WeeklySlotType",
  status                   "AssignmentStatus"  NOT NULL DEFAULT 'assigned',
  target_count             INTEGER             NOT NULL,
  progress_count           INTEGER             NOT NULL DEFAULT 0,
  is_overlap_with_session  BOOLEAN             NOT NULL DEFAULT FALSE,
  eligibility_snapshot     JSONB               NOT NULL,
  assigned_at              TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ         NOT NULL,
  created_at               TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  CONSTRAINT user_challenge_assignments_scope_shape CHECK (
    (scope = 'daily'  AND assignment_date     IS NOT NULL AND assignment_week_key IS NULL     AND weekly_slot_type IS NULL)
 OR (scope = 'weekly' AND assignment_week_key IS NOT NULL AND assignment_date     IS NULL     AND weekly_slot_type IS NOT NULL)
  ),
  CONSTRAINT user_challenge_assignments_progress_nonneg CHECK (progress_count >= 0)
);

-- No duplicate assignment for the same (user, template, period) per scope
CREATE UNIQUE INDEX user_challenge_assignments_daily_unique_idx
  ON user_challenge_assignments (user_id, template_id, assignment_date)
  WHERE scope = 'daily';

CREATE UNIQUE INDEX user_challenge_assignments_weekly_unique_idx
  ON user_challenge_assignments (user_id, template_id, assignment_week_key)
  WHERE scope = 'weekly';

CREATE INDEX user_challenge_assignments_user_date_idx
  ON user_challenge_assignments (user_id, assignment_date);
CREATE INDEX user_challenge_assignments_user_status_scope_idx
  ON user_challenge_assignments (user_id, status, scope);
CREATE INDEX user_challenge_assignments_user_week_idx
  ON user_challenge_assignments (user_id, assignment_week_key);
