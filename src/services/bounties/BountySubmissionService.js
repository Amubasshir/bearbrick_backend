'use strict';

// BountySubmissionService — the submission validation pipeline (spec §10, §13,
// §14.2). Runs in one transaction under a per-user advisory lock so the daily
// counter and stats stay consistent under concurrent submits.
//
// Order of checks:
//   1. bounty instance + definition loaded (bounty_not_found)
//   2. user loaded (user_not_found)
//   3. submission_type + required content present
//   4. eligibility: account_state gate; email verification for IMAGE (§ Q7 auth)
//   5. daily limit (10/day, all outcomes count — Q14; lazy 5 AM-local reset — Q15)
//   6. status branch:
//        OPEN   -> PENDING, capture cash/credit/xp reward on the row (Q5)
//        CLOSED -> auto-REJECT "Already exists" (still counts toward the limit)
//        PAUSED -> blocked (bounty_paused), no row created
//   7. insert submission + update user_bounty_stats (+ daily count)
//
// Rewards are CAPTURED from the definition at submission time and never re-read
// from bounty_definitions later (determinism / Q5). Budget capping happens at
// approval time (A4), not here.

const prisma = require('../../lib/prisma');
const BountyEligibilityService = require('./BountyEligibilityService');
const { FIELD_MAP, calculateBountyXp } = require('./bountyTypes');
const { computeLocalDayKey, toDayKeyString } = require('../../lib/sessions');

class SubmissionError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SubmissionError';
    this.code = code;
  }
}

const DEFAULT_DAILY_LIMIT = 10;

/**
 * Submit a bounty. Returns the created bounty_submissions row (including the
 * auto-rejected "Already exists" case, which is still a created row).
 * Throws SubmissionError(code) on a blocked submission (no row created).
 */
async function submit(prismaClient, input) {
  const {
    userId,
    bountyInstanceId,
    submissionType,
    contentUrl = null,
    contentText = null,
    sourceUrl = null,
    notes = null,
    now = new Date(),
  } = input;

  const userIdBig = BigInt(userId);

  return (prismaClient || prisma).$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext('bounty_submit:' || $1)::bigint)`,
      userIdBig.toString()
    );

    // 1. Instance + definition.
    const instRows = await tx.$queryRawUnsafe(
      `SELECT bi.id, bi.status, bi.target_field, bi.brick_id,
              bd.type, bd.reward_cash_cents, bd.reward_credits, bd.priority
       FROM bounty_instances bi
       JOIN bounty_definitions bd ON bd.id = bi.bounty_definition_id
       WHERE bi.id = $1::uuid LIMIT 1`,
      bountyInstanceId
    );
    const inst = instRows[0];
    if (!inst) throw new SubmissionError('bounty_not_found');

    // 2. User.
    const userRows = await tx.$queryRawUnsafe(
      `SELECT id, account_state, email_verified_at, timezone FROM "User" WHERE id = $1 LIMIT 1`,
      userIdBig
    );
    const userRow = userRows[0];
    if (!userRow) throw new SubmissionError('user_not_found');

    // 3. submission_type + content.
    if (submissionType !== 'IMAGE' && submissionType !== 'DATA') {
      throw new SubmissionError('invalid_submission_type');
    }
    if (submissionType === 'IMAGE' && !contentUrl) {
      throw new SubmissionError('missing_content_url');
    }
    if (submissionType === 'DATA' && !contentText) {
      throw new SubmissionError('missing_content_text');
    }

    // 4. Eligibility.
    const elig = BountyEligibilityService.evaluate(userRow, {
      requiresEmailVerification: submissionType === 'IMAGE',
    });
    if (!elig.eligible) throw new SubmissionError(elig.reason);

    // 5. Daily limit (lazy 5 AM-local reset).
    const stats = await loadStats(tx, userIdBig);
    const tz = userRow.timezone || 'UTC';
    const todayKey = computeLocalDayKey(now, tz);
    const limit = stats ? stats.daily_submission_limit : DEFAULT_DAILY_LIMIT;
    const sameDay =
      stats &&
      stats.daily_submission_reset_at &&
      toDayKeyString(new Date(stats.daily_submission_reset_at)) === toDayKeyString(todayKey);
    const currentCount = sameDay ? stats.daily_submission_count : 0;
    if (currentCount >= limit) throw new SubmissionError('daily_limit_reached');

    // 6. Status branch.
    let status;
    let rejectionReasons = null;
    let cashReward = 0;
    let creditReward = 0;
    let xpReward = 0;
    if (inst.status === 'OPEN') {
      status = 'PENDING';
      cashReward = inst.reward_cash_cents;
      creditReward = inst.reward_credits;
      xpReward = calculateBountyXp(inst.priority);
    } else if (inst.status === 'CLOSED') {
      status = 'REJECTED';
      rejectionReasons = ['Already exists'];
    } else {
      throw new SubmissionError('bounty_paused');
    }

    // 7a. Insert submission (rewards captured here).
    const subRows = await tx.$queryRawUnsafe(
      `INSERT INTO bounty_submissions
         (bounty_instance_id, brick_id, user_id, submission_type,
          content_url, content_text, source_url, notes,
          status, rejection_reasons, cash_reward_cents, credit_reward, xp_reward,
          reviewed_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               CASE WHEN $9 = 'REJECTED' THEN NOW() ELSE NULL END)
       RETURNING id, status, cash_reward_cents, credit_reward, xp_reward,
                 bounty_instance_id, brick_id, user_id`,
      inst.id, inst.brick_id, userIdBig, submissionType,
      contentUrl, contentText, sourceUrl, notes,
      status, rejectionReasons, cashReward, creditReward, xpReward
    );
    const submission = subRows[0];

    // 7b. Stats + daily counter (all submissions count — Q14).
    const newDaily = currentCount + 1;
    const pendingDelta = status === 'PENDING' ? 1 : 0;
    const rejectedDelta = status === 'REJECTED' ? 1 : 0;
    await tx.$executeRawUnsafe(
      `INSERT INTO user_bounty_stats
         (user_id, total_submissions, pending_submissions, accepted_submissions,
          rejected_submissions, daily_submission_count, daily_submission_limit,
          daily_submission_reset_at, approval_rate, updated_at)
       VALUES ($1, 1, $2, 0, $3, $4, $5, $6::date, 0, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         total_submissions    = user_bounty_stats.total_submissions + 1,
         pending_submissions  = user_bounty_stats.pending_submissions + $2,
         rejected_submissions = user_bounty_stats.rejected_submissions + $3,
         daily_submission_count    = $4,
         daily_submission_reset_at = $6::date,
         updated_at = NOW()`,
      userIdBig, pendingDelta, rejectedDelta, newDaily, DEFAULT_DAILY_LIMIT, todayKey
    );
    // Recompute approval_rate = accepted / (accepted + rejected) (§13.2).
    await tx.$executeRawUnsafe(
      `UPDATE user_bounty_stats SET approval_rate =
         CASE WHEN (accepted_submissions + rejected_submissions) = 0 THEN 0
              ELSE ROUND(accepted_submissions::numeric
                         / (accepted_submissions + rejected_submissions), 2) END
       WHERE user_id = $1`,
      userIdBig
    );

    return submission;
  });
}

async function loadStats(tx, userIdBig) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT daily_submission_count, daily_submission_limit, daily_submission_reset_at
     FROM user_bounty_stats WHERE user_id = $1 LIMIT 1`,
    userIdBig
  );
  return rows[0] || null;
}

module.exports = {
  submit,
  SubmissionError,
  DEFAULT_DAILY_LIMIT,
};
