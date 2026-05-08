-- Migration 4: user_progress_state — worker-owned derived read model + bootstrap

CREATE TABLE user_progress_state (
  user_id                     BIGINT      PRIMARY KEY REFERENCES "User"(id),
  total_xp_confirmed          INTEGER     NOT NULL DEFAULT 0,
  current_level               INTEGER     NOT NULL DEFAULT 1,
  highest_level_ever          INTEGER     NOT NULL DEFAULT 1,
  last_reconciled_xp_event_id BIGINT      NOT NULL DEFAULT 0,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bootstrap: initialize from existing confirmed xp_events
WITH user_totals AS (
  SELECT
    user_id,
    COALESCE(SUM(xp_delta_signed), 0) AS total_xp,
    MAX(id)                            AS max_event_id
  FROM xp_events
  WHERE xp_confirmed = TRUE
  GROUP BY user_id
),
user_levels AS (
  SELECT
    ut.user_id,
    ut.total_xp,
    ut.max_event_id,
    COALESCE(
      (SELECT MAX(ld.level_number)
       FROM level_definitions ld
       WHERE ld.min_xp <= ut.total_xp AND ld.is_active = TRUE),
      1
    ) AS resolved_level
  FROM user_totals ut
)
INSERT INTO user_progress_state
  (user_id, total_xp_confirmed, current_level, highest_level_ever, last_reconciled_xp_event_id)
SELECT
  user_id,
  total_xp,
  resolved_level,
  resolved_level,
  max_event_id
FROM user_levels
ON CONFLICT (user_id) DO NOTHING;
