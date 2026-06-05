'use strict';

// daily-submission-counter-reset-worker — backstop sweep that zeroes a user's
// daily_submission_count once their local day rolls past the 5 AM boundary
// (spec §13). BountySubmissionService already lazy-resets the counter on the
// next submission; this worker is the safety net for users who don't submit
// again before they expect a fresh quota.
//
// Local day is computed per user from User.timezone (UTC fallback is automatic
// since the column defaults to 'UTC'), using the same computeLocalDayKey 5 AM
// boundary as the submission path. Each user's reset runs under the SAME
// per-user advisory lock the submission path takes ('bounty_submit:<id>'), so a
// concurrent submit and this sweep can never lose an update.

const prisma = require('../lib/prisma');
const { computeLocalDayKey, toDayKeyString } = require('../lib/sessions');

/**
 * Reset one user's daily counter iff their stored day key is no longer the
 * current local day. Re-reads under the advisory lock. Returns true if reset.
 */
async function resetUser(prismaClient, userId, now) {
  const userIdBig = BigInt(userId);
  return prismaClient.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext('bounty_submit:' || $1)::bigint)`,
      userIdBig.toString()
    );
    const rows = await tx.$queryRawUnsafe(
      `SELECT s.daily_submission_count, s.daily_submission_reset_at, u.timezone
         FROM user_bounty_stats s JOIN "User" u ON u.id = s.user_id
        WHERE s.user_id = $1 LIMIT 1`,
      userIdBig
    );
    const r = rows[0];
    if (!r || r.daily_submission_count === 0) return false;

    const tz = r.timezone || 'UTC';
    const currentKey = toDayKeyString(computeLocalDayKey(now, tz));
    const storedKey = r.daily_submission_reset_at
      ? toDayKeyString(new Date(r.daily_submission_reset_at)) : null;
    if (storedKey === currentKey) return false; // counter is still for today

    await tx.$executeRawUnsafe(
      `UPDATE user_bounty_stats
         SET daily_submission_count = 0, daily_submission_reset_at = $2::date, updated_at = NOW()
       WHERE user_id = $1`,
      userIdBig, currentKey
    );
    return true;
  });
}

/**
 * Run one sweep. `options.userIds` scopes to specific users (tests); otherwise
 * every stats row with a non-zero counter is a candidate. Returns
 * { candidates, reset }.
 */
async function processOneTick(prismaClient = prisma, options = {}) {
  const now = options.now ?? new Date();
  const scoped = Array.isArray(options.userIds) && options.userIds.length > 0;
  const rows = scoped
    ? await prismaClient.$queryRawUnsafe(
      `SELECT user_id FROM user_bounty_stats
        WHERE daily_submission_count > 0 AND user_id = ANY($1::bigint[])`,
      options.userIds.map((id) => BigInt(id))
    )
    : await prismaClient.$queryRawUnsafe(
      `SELECT user_id FROM user_bounty_stats WHERE daily_submission_count > 0`
    );

  let reset = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await resetUser(prismaClient, row.user_id, now)) reset += 1;
  }
  return { candidates: rows.length, reset };
}

async function runWorkerLoop() {
  console.log('[daily-submission-counter-reset-worker] starting');
  const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly sweep
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await processOneTick(prisma);
      if (r.reset) console.log(`[daily-submission-counter-reset-worker] reset ${r.reset}/${r.candidates}`);
    } catch (err) {
      console.error('[daily-submission-counter-reset-worker] tick error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { processOneTick, resetUser };

if (require.main === module) {
  runWorkerLoop().catch((err) => {
    console.error('[daily-submission-counter-reset-worker] fatal:', err);
    process.exit(1);
  });
}
