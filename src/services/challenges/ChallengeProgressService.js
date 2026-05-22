'use strict';

// ChallengeProgressService — given a fresh vote_event, advance any matching
// active assignments for the user, mint completion + XP events, and (if all 5
// dailies are now done) mint the all-five-dailies bonus.
//
// Design choices (per approved plan):
//   • Re-compute progress_count from canonical truth (vote_events) on every
//     run instead of doing increment-and-pray. Slightly more SQL but
//     dedup-by-construction; safe under crash-replay.
//   • XP idempotency keys are the single source of double-grant defense:
//       - challenge_complete:{assignment_id}   (in challenge_completion_events)
//       - challenge_xp:{assignment_id}         (in xp_events)
//       - all_five_dailies:{user_id}:{day_key} (in xp_events)
//   • per_unique_category degrades to per_unique_brick until the bricks table
//     grows a category column (documented limitation).

const prisma = require('../../lib/prisma');
const { insertXpEvent } = require('../../lib/xpEvents');
const { computeLocalDayKey, toDayKeyString } = require('../../lib/sessions');
const TemplateService = require('./ChallengeTemplateService');
const AssignmentService = require('./ChallengeAssignmentService');
const { mondayOf } = require('../../lib/weeks');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Does this vote event's payload satisfy the template's predicate?
 * Match keys understood here:
 *   - vote_type: string | string[]  (event.vote_type must be one of)
 *   - is_stale:  boolean            (queried lazily inside recompute, NOT here)
 * Empty match = always true.
 */
function predicateMatches(template, voteEvent) {
  const ld = template.logic_definition || {};
  if (ld.trigger && ld.trigger !== 'vote_event') return false;
  const m = ld.match || {};
  if (m.vote_type) {
    const allowed = Array.isArray(m.vote_type) ? m.vote_type : [m.vote_type];
    if (!allowed.includes(voteEvent.vote_type)) return false;
  }
  // is_stale is checked at recompute time via SQL; if present, the predicate
  // narrows to stale-only.
  return true;
}

// ---------------------------------------------------------------------------
// Progress recompute — query truth, not a memory of past events.
// ---------------------------------------------------------------------------

async function recomputeProgress(tx, assignment, template) {
  const ld = template.logic_definition || {};
  const strategy = ld.count_strategy || 'per_event';
  const wantStale = ld.match && ld.match.is_stale === true;
  const wantVoteTypes = ld.match && ld.match.vote_type
    ? (Array.isArray(ld.match.vote_type) ? ld.match.vote_type : [ld.match.vote_type])
    : null;

  // Build the WHERE clause incrementally. For daily, restrict to the
  // assignment_date in user-local terms (vote.created_at falls within the
  // local-day window). For weekly, restrict to the local week.
  const params = [];
  let where = `ve.user_id = $${params.push(BigInt(assignment.user_id))}`;

  if (assignment.scope === 'daily') {
    // assignment_date is the local_day_key; convert by recomputing
    // local_day_key for each vote's created_at against the user's timezone.
    // We approximate by date-comparing (vote.created_at + small TZ offset) to
    // assignment_date. The most reliable shortcut: vote_events written today
    // by this user inherit the user's timezone. We've already filtered by
    // assigned_at <= vote.created_at via the assigned_at boundary below.
    where += ` AND ve."createdAt" >= $${params.push(assignment.assigned_at)}`;
    where += ` AND ve."createdAt" < $${params.push(assignment.expires_at)}`;
  } else {
    where += ` AND ve."createdAt" >= $${params.push(assignment.assigned_at)}`;
    where += ` AND ve."createdAt" < $${params.push(assignment.expires_at)}`;
  }

  if (wantVoteTypes) {
    where += ` AND ve.vote_type::text = ANY($${params.push(wantVoteTypes)}::text[])`;
  }

  if (wantStale) {
    where += ` AND EXISTS (
      SELECT 1 FROM brick_vote_state bvs
       WHERE bvs.brick_id = ve.brick_id AND bvs.stale_status = 'stale'
    )`;
  }

  let countSql;
  if (strategy === 'per_unique_brick' || strategy === 'per_unique_category') {
    // per_unique_category degrades to per_unique_brick until category tracking exists.
    countSql = `SELECT COUNT(DISTINCT ve.brick_id)::int AS n FROM vote_events ve WHERE ${where}`;
  } else {
    countSql = `SELECT COUNT(*)::int AS n FROM vote_events ve WHERE ${where}`;
  }

  const rows = await tx.$queryRawUnsafe(countSql, ...params);
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Per-vote handler — called from the worker inside a per-user transaction.
// ---------------------------------------------------------------------------

async function processOneVoteForChallenges(tx, voteEvent) {
  const userIdBig = BigInt(voteEvent.user_id);
  const createdAt = voteEvent.created_at instanceof Date
    ? voteEvent.created_at
    : new Date(voteEvent.created_at);

  const userRows = await tx.$queryRawUnsafe(
    `SELECT timezone FROM "User" WHERE id = $1`, userIdBig
  );
  const timezone = userRows[0]?.timezone || 'UTC';
  const localDayKey = computeLocalDayKey(createdAt, timezone);
  const dayIso = toDayKeyString(localDayKey);
  const weekKeyIso = toDayKeyString(mondayOf(localDayKey));

  // First-meaningful-action hook: ensure dailies + weeklies exist.
  await AssignmentService.getOrAssignDailies(userIdBig, createdAt, tx);
  await AssignmentService.getOrAssignWeeklies(userIdBig, createdAt, tx);

  // Load all relevant active assignments (daily for today + weekly for this
  // week). We don't fetch challenge_completion_events separately — completion
  // is encoded in status.
  const assignments = await tx.$queryRawUnsafe(
    `SELECT uca.id, uca.user_id, uca.template_id, uca.scope, uca.assignment_date,
            uca.assignment_week_key, uca.assigned_at, uca.expires_at,
            uca.target_count, uca.progress_count, uca.status,
            ct.code AS template_code, ct.logic_definition,
            ct.reward_xp_base, ct.reward_xp_bonus
       FROM user_challenge_assignments uca
       JOIN challenge_templates ct ON ct.id = uca.template_id
      WHERE uca.user_id = $1
        AND uca.status = 'assigned'
        AND ((uca.scope = 'daily'  AND uca.assignment_date     = $2::date)
          OR (uca.scope = 'weekly' AND uca.assignment_week_key = $3::date))`,
    userIdBig, dayIso, weekKeyIso
  );

  const xpConfig = await loadXpAmounts(tx);

  for (const a of assignments) {
    if (!predicateMatches(a, voteEvent)) continue;

    const newProgress = await recomputeProgress(tx, a, a);
    const oldProgress = Number(a.progress_count);
    if (newProgress === oldProgress) continue;

    // Bump persisted snapshot
    await tx.$queryRawUnsafe(
      `UPDATE user_challenge_assignments
          SET progress_count = $2, updated_at = NOW()
        WHERE id = $1`,
      BigInt(a.id), newProgress
    );

    if (newProgress >= Number(a.target_count)) {
      const xpAmount = Number(a.reward_xp_base) + Number(a.reward_xp_bonus || 0);

      // Mark assignment completed (idempotent on status check)
      await tx.$queryRawUnsafe(
        `UPDATE user_challenge_assignments
            SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'assigned'`,
        BigInt(a.id)
      );

      // Append completion event (idempotency_key UNIQUE prevents dup)
      await tx.$queryRawUnsafe(
        `INSERT INTO challenge_completion_events
           (user_id, challenge_assignment_id, scope, xp_awarded, idempotency_key)
         VALUES ($1, $2, $3::"ChallengeScope", $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        userIdBig, BigInt(a.id), a.scope, xpAmount,
        `challenge_complete:${a.id.toString()}`
      );

      // Mint XP — idempotent via xp_idempotency_keys
      await insertXpEvent(tx, {
        userId: userIdBig,
        voteEventId: BigInt(voteEvent.id),
        xpAmount,
        reason: 'STREAK',
        eventType: 'challenge_completion',
        sourceSystem: 'm3c',
        localDayKey: dayIso,
        idempotencyKey: `challenge_xp:${a.id.toString()}`,
      });
    }
  }

  // After all individual completions, check the all-5-dailies bonus.
  // Counts only daily-scope assignments and only for today's local_day_key.
  await maybeMintAllFiveDailiesBonus(tx, {
    userId: userIdBig,
    localDayKey: dayIso,
    voteEventId: BigInt(voteEvent.id),
    bonusXp: xpConfig.allFiveDailiesBonus,
  });
}

async function loadXpAmounts(tx) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT config FROM xp_config_versions WHERE is_active = TRUE
      ORDER BY version DESC LIMIT 1`
  );
  const amounts = rows[0]?.config?.xpAmounts || {};
  return {
    allFiveDailiesBonus: amounts.all_five_dailies_bonus ?? 100,
    perfectDayBonus:     amounts.perfect_day_bonus       ?? 250,
  };
}

async function maybeMintAllFiveDailiesBonus(tx, { userId, localDayKey, voteEventId, bonusXp }) {
  const counts = await tx.$queryRawUnsafe(
    `SELECT
       COUNT(*)::int                              AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int AS done
     FROM user_challenge_assignments
     WHERE user_id = $1 AND scope = 'daily' AND assignment_date = $2::date`,
    userId, localDayKey
  );
  const total = counts[0]?.total ?? 0;
  const done = counts[0]?.done ?? 0;
  if (total < 5 || done < 5) return; // not yet — keep waiting

  const key = `all_five_dailies:${userId.toString()}:${localDayKey}`;
  await insertXpEvent(tx, {
    userId,
    voteEventId,
    xpAmount: bonusXp,
    reason: 'STREAK',
    eventType: 'all_five_dailies_bonus',
    sourceSystem: 'm3c',
    localDayKey,
    idempotencyKey: key,
  });
}

module.exports = {
  processOneVoteForChallenges,
  predicateMatches,
  recomputeProgress,
};
