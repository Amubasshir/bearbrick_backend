'use strict';

// Score computation per metric_type. Each function returns:
//   { score: number|string, tie_break_timestamp: Date|null, tie_break_event_id: BigInt|null }
//
// Scores are recomputed from canonical sources each tick — never from a
// running counter. This mirrors the M3c "recompute truth, not memory"
// precedent and keeps replay deterministic.
//
// Tie-break source-of-truth (per Spec_ANSWERS Q5):
//   xp_events.created_at  →  tie_break_timestamp
//   xp_events.id          →  tie_break_event_id  (secondary)
//   user_id                →  tertiary (applied at ranking time, not stored here)

const prisma = require('../../lib/prisma');
const { utcWeekStartFromKey, nextUtcWeekKey } = require('../../lib/utcWeeks');

const ZERO_SCORE = { score: 0, tie_break_timestamp: null, tie_break_event_id: null };

/**
 * Dispatcher. Looks at definition.metricType + scope and routes to the right
 * scoring function. The contribution stub returns 0 with a TODO so the
 * contribution milestone can wire real numbers in without changing this file's
 * shape.
 */
async function computeScore(definition, userId, periodKey, txOrPrisma = prisma) {
  if (!definition) throw new Error('computeScore: definition is required');
  const userIdBig = BigInt(userId);

  switch (definition.metricType) {
    case 'collector_xp':
      if (definition.scope === 'lifetime') {
        return scoreCollectorXpLifetime(userIdBig, txOrPrisma);
      }
      if (definition.scope === 'weekly') {
        return scoreCollectorXpWeekly(userIdBig, periodKey, txOrPrisma);
      }
      throw new Error(`computeScore: unsupported scope "${definition.scope}" for collector_xp`);

    case 'dex_completion_percent':
      return scoreDexCompletion(userIdBig, txOrPrisma);

    case 'approved_contribution_weight':
      // TODO(contribution-milestone): replace with real query over the
      // approved-contribution ledger. Interface contract:
      //   numerator   = SUM(approved_contribution.weight) for user
      //   denominator = N/A (raw sum, not a percent)
      //   tie_break_timestamp = MAX(approved_at) across user's approvals
      //   tie_break_event_id  = corresponding event id (or null)
      return ZERO_SCORE;

    default:
      throw new Error(`computeScore: unknown metric_type "${definition.metricType}"`);
  }
}

/**
 * Lifetime collector XP: confirmed XP across all time.
 *
 * Reads user_progress_state.total_xp_confirmed (M3a's worker-owned read model)
 * to avoid scanning xp_events on every tick. tie_break_timestamp is derived
 * from the LATEST confirmed xp_event for this user — the event whose creation
 * caused the user to reach their current cumulative total.
 *
 * Note on Q5 strictness: the spec says "earliest event that caused the user
 * to first reach their final score". For an ever-increasing lifetime score,
 * the "final score" changes every event — so the event whose created_at the
 * user FIRST reached the current total is, by definition, the latest event.
 * For ties between two users at the same lifetime score, the user whose
 * latest contributing event happened earlier wins — i.e. the user who's been
 * sitting at that score longer.
 */
async function scoreCollectorXpLifetime(userId, txOrPrisma = prisma) {
  const stateRows = await txOrPrisma.$queryRawUnsafe(
    `SELECT total_xp_confirmed FROM user_progress_state WHERE user_id = $1`,
    userId
  );
  const totalXp = stateRows[0]?.total_xp_confirmed != null
    ? Number(stateRows[0].total_xp_confirmed)
    : 0;

  if (totalXp === 0) return ZERO_SCORE;

  // Find the LATEST confirmed xp_event — that's when the user reached the
  // current total. ORDER BY created_at ASC, id ASC per Q5; the latest in
  // that ordering is what we want.
  const lastEvent = await txOrPrisma.$queryRawUnsafe(
    `SELECT id, "createdAt" AS created_at
       FROM xp_events
      WHERE user_id = $1 AND xp_confirmed = TRUE
      ORDER BY "createdAt" DESC, id DESC
      LIMIT 1`,
    userId
  );

  return {
    score: totalXp,
    tie_break_timestamp: lastEvent[0]?.created_at || null,
    tie_break_event_id: lastEvent[0]?.id != null ? BigInt(lastEvent[0].id) : null,
  };
}

/**
 * Weekly collector XP: confirmed XP for the given UTC ISO week.
 *
 * Per Spec_ANSWERS Q9: a vote's leaderboard period is determined by
 * xp_events.created_at (UTC instant), not by the user's local timezone, not
 * by when the worker processes it. An event at 23:59:59 UTC on Sunday counts
 * for the OLD week; one at 00:00:00 UTC on Monday counts for the NEW week.
 *
 * Tie-break per Q5: the user FIRST reaches their weekly total at the LATEST
 * event that contributes — the event whose created_at, in the ORDER BY ASC
 * traversal, lands them at the final score. We sort DESC + LIMIT 1 to find it.
 */
async function scoreCollectorXpWeekly(userId, periodKey, txOrPrisma = prisma) {
  const start = utcWeekStartFromKey(periodKey);
  const end = utcWeekStartFromKey(nextUtcWeekKey(periodKey));

  const sumRow = await txOrPrisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(xp_delta_signed), 0)::int AS total
       FROM xp_events
      WHERE user_id    = $1
        AND xp_confirmed = TRUE
        AND "createdAt" >= $2
        AND "createdAt" <  $3`,
    userId, start, end
  );
  const total = Number(sumRow[0]?.total ?? 0);

  if (total === 0) return ZERO_SCORE;

  const lastEvent = await txOrPrisma.$queryRawUnsafe(
    `SELECT id, "createdAt" AS created_at
       FROM xp_events
      WHERE user_id    = $1
        AND xp_confirmed = TRUE
        AND "createdAt" >= $2
        AND "createdAt" <  $3
      ORDER BY "createdAt" DESC, id DESC
      LIMIT 1`,
    userId, start, end
  );

  return {
    score: total,
    tie_break_timestamp: lastEvent[0]?.created_at || null,
    tie_break_event_id: lastEvent[0]?.id != null ? BigInt(lastEvent[0].id) : null,
  };
}

/**
 * Dex completion percentage: mirrors M2's canonical computation already used
 * in src/controllers/dex/DexLeaderboardController.js (completionLeaderboard).
 *
 *   numerator   = COUNT(user_brick_progress WHERE user_id=? AND stage=3)
 *   denominator = COUNT(Brick WHERE status='PUBLISHED')
 *   score       = numerator / denominator * 100   (NUMERIC, not rounded)
 *
 * tie_break_timestamp = MAX(updatedAt) across the user's stage=3 rows
 *   (whichever brick they completed most recently put them at this percent).
 * tie_break_event_id  = NULL (Dex has no event id table aligned to this metric).
 */
async function scoreDexCompletion(userId, txOrPrisma = prisma) {
  const [denomRow] = await txOrPrisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM bricks WHERE status = 'PUBLISHED'`
  );
  const denom = Number(denomRow?.n || 0);
  if (denom === 0) return ZERO_SCORE;

  const [numRow] = await txOrPrisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n, MAX(updated_at) AS last_updated
       FROM user_brick_progress
      WHERE user_id = $1 AND stage = 3`,
    userId
  );
  const num = Number(numRow?.n || 0);
  if (num === 0) return ZERO_SCORE;

  const pct = (num / denom) * 100;
  return {
    score: pct,
    tie_break_timestamp: numRow.last_updated || null,
    tie_break_event_id: null,
  };
}

module.exports = {
  computeScore,
  scoreCollectorXpLifetime,
  scoreCollectorXpWeekly,
  scoreDexCompletion,
  ZERO_SCORE,
};
