-- M3b Migration 13 (follow-up): allow user_session_brick_counts.vote_event_id
-- to be NULL so guest-session conversion at signup can carry counted bricks
-- before any VoteEvent exists. Worker-driven inserts continue to populate it.

ALTER TABLE user_session_brick_counts
  ALTER COLUMN vote_event_id DROP NOT NULL;
