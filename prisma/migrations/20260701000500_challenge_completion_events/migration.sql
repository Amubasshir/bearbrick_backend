-- M3c Migration 4: challenge_completion_events
-- Immutable record per spec §11.4. Append-only by convention.
-- idempotency_key shape: "challenge_complete:{assignment_id}" for daily/weekly
-- completions; the corresponding XP event uses "challenge_xp:{assignment_id}".

CREATE TABLE challenge_completion_events (
  id                       BIGSERIAL          PRIMARY KEY,
  user_id                  BIGINT             NOT NULL REFERENCES "User"(id),
  challenge_assignment_id  BIGINT             NOT NULL REFERENCES user_challenge_assignments(id),
  scope                    "ChallengeScope"   NOT NULL,
  completed_at             TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  xp_awarded               INTEGER            NOT NULL,
  idempotency_key          VARCHAR(255)       NOT NULL UNIQUE,
  created_at               TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE INDEX challenge_completion_events_user_completed_idx
  ON challenge_completion_events (user_id, completed_at DESC);
CREATE INDEX challenge_completion_events_assignment_idx
  ON challenge_completion_events (challenge_assignment_id);
