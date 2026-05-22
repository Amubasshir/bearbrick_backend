'use strict';

// Atomic rerank of one (leaderboard_key, period_key) slice.
//
// Two passes inside the caller's transaction:
//   1. Number eligible rows by ORDER BY score DESC, tie_break_timestamp ASC,
//      tie_break_event_id ASC NULLS LAST, user_id ASC (Spec_ANSWERS Q5).
//   2. NULL the rank of every ineligible row.
//
// The caller MUST hold the period advisory lock
// (pg_advisory_xact_lock(hash(lb_key, period_key))). The lock prevents two
// workers from reranking the same slice concurrently — ROW_NUMBER() OVER ()
// is atomic per statement but interleaving with state upserts would race.
//
// `last_updated_at` is bumped on every reranked row so the read API can
// surface freshness (e.g. "ranks recomputed N seconds ago"). It does NOT
// drive tie-break logic — that's xp_events.created_at only, per Q5.

const prisma = require('../../lib/prisma');

/**
 * Acquires the period-level advisory lock inside the current transaction.
 * Caller must already have `BEGIN`'d. Locks released on COMMIT/ROLLBACK.
 *
 * @param {*} tx
 * @param {string} leaderboardKey
 * @param {string} periodKey
 */
async function acquirePeriodLock(tx, leaderboardKey, periodKey) {
  // hashtext is deterministic per (leaderboard_key, period_key) string.
  // Cast to bigint so pg_advisory_xact_lock's single-arg form works.
  // Must use $executeRawUnsafe (not $queryRaw) because the lock function
  // returns void — same convention as M3a/M3b/M3c workers.
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext($1 || '|' || $2)::bigint)`,
    leaderboardKey, periodKey
  );
}

/**
 * Reranks one slice. Returns the count of ranked (eligible) rows for caller
 * logging and snapshot sizing.
 *
 * SQL strategy:
 *   - Subquery materializes ROW_NUMBER() over the canonical sort.
 *   - Outer UPDATE assigns rank by joining on id.
 *   - Separate UPDATE nulls ineligible rows' ranks (might have been ranked
 *     in a previous tick before the user crossed back below threshold).
 */
async function rerank(tx, leaderboardKey, periodKey) {
  await tx.$executeRawUnsafe(
    `UPDATE leaderboard_state ls
        SET rank = sub.rank,
            last_updated_at = NOW()
       FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  ORDER BY score DESC,
                           tie_break_timestamp ASC NULLS LAST,
                           tie_break_event_id ASC NULLS LAST,
                           user_id ASC
                )::int AS rank
           FROM leaderboard_state
          WHERE leaderboard_key = $1
            AND period_key      = $2
            AND eligible        = TRUE
       ) sub
      WHERE ls.id = sub.id`,
    leaderboardKey, periodKey
  );

  await tx.$executeRawUnsafe(
    `UPDATE leaderboard_state
        SET rank = NULL,
            last_updated_at = NOW()
      WHERE leaderboard_key = $1
        AND period_key      = $2
        AND eligible        = FALSE
        AND rank IS NOT NULL`,
    leaderboardKey, periodKey
  );

  const [countRow] = await tx.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n
       FROM leaderboard_state
      WHERE leaderboard_key = $1
        AND period_key      = $2
        AND eligible        = TRUE`,
    leaderboardKey, periodKey
  );
  return Number(countRow?.n || 0);
}

/**
 * Upsert one user's row in `leaderboard_state` and return the upserted row.
 * No rerank — caller is expected to follow with `rerank()` once per slice
 * after all upserts for that slice are done.
 *
 * Uses ON CONFLICT (leaderboard_key, period_key, user_id) DO UPDATE so a
 * worker retick on the same user is safe.
 */
async function upsertState(tx, {
  leaderboardKey,
  periodKey,
  userId,
  score,
  eligible,
  tieBreakTimestamp,
  tieBreakEventId,
}) {
  const userIdBig = BigInt(userId);
  const tbEventId = tieBreakEventId == null ? null : BigInt(tieBreakEventId);
  await tx.$executeRawUnsafe(
    `INSERT INTO leaderboard_state
       (leaderboard_key, period_key, user_id, score, eligible,
        tie_break_timestamp, tie_break_event_id, last_updated_at)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, NOW())
     ON CONFLICT (leaderboard_key, period_key, user_id) DO UPDATE
       SET score               = EXCLUDED.score,
           eligible            = EXCLUDED.eligible,
           tie_break_timestamp = EXCLUDED.tie_break_timestamp,
           tie_break_event_id  = EXCLUDED.tie_break_event_id,
           last_updated_at     = NOW()`,
    leaderboardKey,
    periodKey,
    userIdBig,
    String(score),
    !!eligible,
    tieBreakTimestamp,
    tbEventId
  );
}

module.exports = {
  acquirePeriodLock,
  rerank,
  upsertState,
};
