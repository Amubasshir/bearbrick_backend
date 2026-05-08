'use strict';

/**
 * UPSERT a row into active_votes for the given vote event.
 * Always called per processed VoteEvent — independent of session membership.
 */
async function recordVote(tx, voteEvent) {
  await tx.$queryRawUnsafe(
    `INSERT INTO active_votes
       (user_id, brick_id, current_vote_type, current_vote_event_id,
        vote_count_for_brick, first_voted_at, last_voted_at)
     VALUES ($1, $2, $3::"VoteType", $4, 1, $5, $5)
     ON CONFLICT (user_id, brick_id) DO UPDATE
       SET current_vote_type     = EXCLUDED.current_vote_type,
           current_vote_event_id = EXCLUDED.current_vote_event_id,
           vote_count_for_brick  = active_votes.vote_count_for_brick + 1,
           last_voted_at         = EXCLUDED.last_voted_at`,
    BigInt(voteEvent.user_id),
    voteEvent.brick_id,
    voteEvent.vote_type,
    BigInt(voteEvent.id),
    voteEvent.created_at
  );
}

module.exports = { recordVote };
