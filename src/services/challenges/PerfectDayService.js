'use strict';

// PerfectDayService — per spec Q3.
//
// Evaluation is event-driven (called from the perfect-day-worker after each
// session_completion_events or challenge_completion_events insertion). The
// worker hands us (user_id, local_day_key) and we check all three Perfect
// Day conditions against the canonical event tables.
//
// Idempotency:
//   • perfect_day_events.UNIQUE (user_id, local_date) prevents row dup.
//   • xp_events idempotency_key 'perfect_day:{user_id}:{local_day_key}'
//     prevents XP dup (Q3 mandates this exact shape).
//
// Crossing midnight is a non-issue: we operate on stored local_day_key only;
// calendar wall-clock is never consulted.

const prisma = require('../../lib/prisma');
const { insertXpEvent } = require('../../lib/xpEvents');

const DEFAULT_DAILY_TARGET = 5;
const DEFAULT_BONUS_XP = 250;

async function loadConfig(tx) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT config FROM xp_config_versions WHERE is_active = TRUE
      ORDER BY version DESC LIMIT 1`
  );
  const cfg = rows[0]?.config || {};
  return {
    dailyTarget: cfg.challenges?.daily_assignment_count ?? DEFAULT_DAILY_TARGET,
    bonusXp:     cfg.xpAmounts?.perfect_day_bonus       ?? DEFAULT_BONUS_XP,
  };
}

/**
 * Check the three conditions and award Perfect Day if all met.
 * Returns the perfect_day_events row inserted, or null if no award (either
 * already awarded or a condition unmet).
 */
async function maybeAward(tx, userId, localDayKey, voteEventId = null) {
  const userIdBig = BigInt(userId);

  // Short-circuit: already awarded?
  const existing = await tx.$queryRawUnsafe(
    `SELECT id FROM perfect_day_events
      WHERE user_id = $1 AND local_date = $2::date`,
    userIdBig, localDayKey
  );
  if (existing.length > 0) return null;

  const { dailyTarget, bonusXp } = await loadConfig(tx);

  // Condition 1: Morning session completion event present?
  const morning = await tx.$queryRawUnsafe(
    `SELECT 1 FROM session_completion_events
      WHERE user_id = $1 AND kind = 'MORNING' AND local_day_key = $2::date
      LIMIT 1`,
    userIdBig, localDayKey
  );
  if (morning.length === 0) return null;

  // Condition 2: Evening session completion event present?
  const evening = await tx.$queryRawUnsafe(
    `SELECT 1 FROM session_completion_events
      WHERE user_id = $1 AND kind = 'EVENING' AND local_day_key = $2::date
      LIMIT 1`,
    userIdBig, localDayKey
  );
  if (evening.length === 0) return null;

  // Condition 3: at least N daily-scope challenge completions for the same
  // local_day_key. We count via the join — challenge_completion_events
  // doesn't store local_day_key directly, but its parent assignment does.
  const dailyDone = await tx.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n
       FROM challenge_completion_events cce
       JOIN user_challenge_assignments uca ON uca.id = cce.challenge_assignment_id
      WHERE cce.user_id = $1
        AND uca.scope = 'daily'
        AND uca.assignment_date = $2::date`,
    userIdBig, localDayKey
  );
  if ((dailyDone[0]?.n ?? 0) < dailyTarget) return null;

  // All three conditions met — award.
  const idKey = `perfect_day:${userIdBig.toString()}:${localDayKey}`;
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO perfect_day_events
       (user_id, local_date, morning_completed, evening_completed,
        all_dailies_completed, perfect_day_awarded, idempotency_key)
     VALUES ($1, $2::date, TRUE, TRUE, TRUE, TRUE, $3)
     ON CONFLICT (user_id, local_date) DO NOTHING
     RETURNING *`,
    userIdBig, localDayKey, idKey
  );
  if (inserted.length === 0) return null; // raced by another worker

  // Mint the Perfect Day bonus XP event with the SAME idempotency_key shape.
  // insertXpEvent enforces uniqueness via xp_idempotency_keys.
  await insertXpEvent(tx, {
    userId: userIdBig,
    voteEventId,
    xpAmount: bonusXp,
    reason: 'STREAK',
    eventType: 'perfect_day_bonus',
    sourceSystem: 'm3c',
    localDayKey,
    idempotencyKey: idKey,
  });

  return inserted[0];
}

module.exports = {
  maybeAward,
  loadConfig,
};
