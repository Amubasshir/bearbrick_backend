-- M3b Migration 8: active_votes
-- One row per (user, brick): the user's *current* stance after the latest vote.
-- Updated on every new VoteEvent (not VoteIntent).

CREATE TABLE active_votes (
  user_id               BIGINT       NOT NULL REFERENCES "User"(id),
  brick_id              TEXT         NOT NULL REFERENCES bricks(id),
  current_vote_type     "VoteType"   NOT NULL,
  current_vote_event_id BIGINT       NOT NULL REFERENCES vote_events(id),
  vote_count_for_brick  INTEGER      NOT NULL DEFAULT 1,
  first_voted_at        TIMESTAMPTZ  NOT NULL,
  last_voted_at         TIMESTAMPTZ  NOT NULL,
  PRIMARY KEY (user_id, brick_id)
);

CREATE INDEX active_votes_brick_idx ON active_votes (brick_id);
