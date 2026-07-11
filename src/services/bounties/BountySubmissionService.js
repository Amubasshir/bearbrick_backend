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
    contentPath = null,
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
          content_url, content_path, content_text, source_url, notes,
          status, rejection_reasons, cash_reward_cents, credit_reward, xp_reward,
          reviewed_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               CASE WHEN $10 = 'REJECTED' THEN NOW() ELSE NULL END)
       RETURNING id, status, cash_reward_cents, credit_reward, xp_reward,
                 bounty_instance_id, brick_id, user_id`,
      inst.id, inst.brick_id, userIdBig, submissionType,
      contentUrl, contentPath, contentText, sourceUrl, notes,
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

/**
 * List a single user's own submissions, newest-first (spec §18.1 "Get My
 * Submissions"). Strictly caller-scoped: WHERE user_id = $1. Returns the row's
 * captured reward amounts (immune to later definition changes). Never joins to
 * expose anything beyond the user's own submission rows.
 */
async function listForUser(userId, client = prisma) {
  return (client || prisma).$queryRawUnsafe(
    `SELECT id, bounty_instance_id, brick_id, submission_type,
            content_url, content_text, source_url, notes,
            status, rejection_reasons, admin_notes,
            cash_reward_cents, credit_reward, xp_reward,
            created_at, reviewed_at
     FROM bounty_submissions
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC`,
    BigInt(userId)
  );
}

/**
 * Read one submission row by id, with the same column set as listForUser so the
 * caller can shape POST and GET responses identically. Used by the create
 * endpoint to return the full created row (submit()'s RETURNING is partial).
 */
async function getById(submissionId, client = prisma) {
  const rows = await (client || prisma).$queryRawUnsafe(
    `SELECT id, bounty_instance_id, brick_id, submission_type,
            content_url, content_text, source_url, notes,
            status, rejection_reasons, admin_notes,
            cash_reward_cents, credit_reward, xp_reward,
            created_at, reviewed_at
     FROM bounty_submissions WHERE id = $1::uuid LIMIT 1`,
    submissionId
  );
  return rows[0] || null;
}

/**
 * Admin review queue (spec §18.1): PENDING submissions across ALL users,
 * oldest-first. Optional bounty_type (via the instance's definition) and
 * brick_id filters. Paginated by limit/offset. Cross-user — NOT caller-scoped.
 */
async function listPendingForAdmin({ bountyType, brickId, limit = 50, offset = 0 } = {}, client = prisma) {
  const params = [];
  const where = ["bs.status = 'PENDING'"];
  if (bountyType) { params.push(bountyType); where.push(`bd.type = $${params.length}`); }
  if (brickId) { params.push(brickId); where.push(`bs.brick_id = $${params.length}`); }
  params.push(limit); const limIdx = params.length;
  params.push(offset); const offIdx = params.length;
  return (client || prisma).$queryRawUnsafe(
    `SELECT bs.id, bs.bounty_instance_id, bs.brick_id, bs.user_id,
            bs.submission_type, bs.status,
            bs.content_url, bs.content_text, bs.source_url, bs.notes,
            bs.cash_reward_cents, bs.credit_reward, bs.xp_reward, bs.created_at,
            bd.type AS bounty_type, bi.target_field
     FROM bounty_submissions bs
     JOIN bounty_instances bi ON bi.id = bs.bounty_instance_id
     JOIN bounty_definitions bd ON bd.id = bi.bounty_definition_id
     WHERE ${where.join(' AND ')}
     ORDER BY bs.created_at ASC, bs.id ASC
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    ...params
  );
}

/**
 * Duplicate-field advisory detector (Unit B2). Returns the ids of any "sibling"
 * submissions in the rewarded-but-not-yet-applied window — status = APPROVED
 * (not APPLIED_TO_BRICK, PENDING, or REJECTED) — whose bounty instance targets
 * the SAME brick_id AND SAME target_field, excluding the submission in question.
 * brick_id is on the submission row; target_field on its instance, hence the
 * join. This is the SINGLE canonical detector: the review queue and the approve
 * echoes all call it so the signal is computed identically everywhere. It is a
 * pure READ (no state change) and NEVER a gate — callers surface it as advisory
 * only. Returns sibling ids oldest-first; [] when none.
 */
async function findApprovedUnappliedSiblings(client, { brickId, targetField, excludeSubmissionId = null } = {}) {
  if (!brickId || !targetField) return [];
  const params = [brickId, targetField];
  let exclude = '';
  if (excludeSubmissionId != null) {
    params.push(excludeSubmissionId);
    exclude = `AND bs.id <> $${params.length}::uuid`;
  }
  const rows = await (client || prisma).$queryRawUnsafe(
    `SELECT bs.id
       FROM bounty_submissions bs
       JOIN bounty_instances bi ON bi.id = bs.bounty_instance_id
      WHERE bs.status = 'APPROVED'
        AND bs.brick_id = $1
        AND bi.target_field = $2
        ${exclude}
      ORDER BY bs.created_at ASC, bs.id ASC`,
    ...params
  );
  return rows.map((r) => r.id);
}

/**
 * The (brickId, targetField) a submission belongs to — brick_id on the row,
 * target_field on its instance. Lets the approve echoes feed
 * findApprovedUnappliedSiblings without re-plumbing the join. null if not found.
 */
async function getFieldContext(client, submissionId) {
  const rows = await (client || prisma).$queryRawUnsafe(
    `SELECT bs.brick_id, bi.target_field
       FROM bounty_submissions bs
       JOIN bounty_instances bi ON bi.id = bs.bounty_instance_id
      WHERE bs.id = $1::uuid LIMIT 1`,
    submissionId
  );
  return rows[0] ? { brickId: rows[0].brick_id, targetField: rows[0].target_field } : null;
}

// Canonical approval_rate recompute (§13.2): accepted / (accepted + rejected),
// 0 when nothing reviewed. Single source for NEW writers; matches the formula
// inlined in submit() and BountyApprovalService.runApprovalCore().
async function recomputeApprovalRate(tx, userIdBig) {
  await tx.$executeRawUnsafe(
    `UPDATE user_bounty_stats SET approval_rate =
       CASE WHEN (accepted_submissions + rejected_submissions) = 0 THEN 0
            ELSE ROUND(accepted_submissions::numeric
                       / (accepted_submissions + rejected_submissions), 2) END
     WHERE user_id = $1`,
    userIdBig
  );
}

/**
 * Admin reject (spec §18.1): flip a PENDING submission to REJECTED with reasons
 * + admin notes, record the reviewer (null under secret-mode admin, matching the
 * PayoutService precedent), and update stats (rejected+1, pending-1, recompute
 * approval_rate). NO reward, NO XP — a rejection mints nothing. The bounty
 * instance is untouched (stays OPEN) so another user can still submit.
 * Throws SubmissionError('submission_not_found' | 'cannot_reject_<status>').
 */
async function reject(prismaClient, { submissionId, rejectionReasons, adminNotes = null, adminUserId = null }) {
  return (prismaClient || prisma).$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, user_id, status FROM bounty_submissions WHERE id = $1::uuid LIMIT 1`,
      submissionId
    );
    const sub = rows[0];
    if (!sub) throw new SubmissionError('submission_not_found');

    const userIdBig = BigInt(sub.user_id);
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext('bounty_reject:' || $1)::bigint)`,
      userIdBig.toString()
    );

    if (sub.status !== 'PENDING') {
      throw new SubmissionError('cannot_reject_' + sub.status.toLowerCase());
    }

    const updated = await tx.$queryRawUnsafe(
      `UPDATE bounty_submissions
         SET status = 'REJECTED', rejection_reasons = $2, admin_notes = $3,
             reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1::uuid RETURNING id, status`,
      submissionId, rejectionReasons, adminNotes, adminUserId != null ? BigInt(adminUserId) : null
    );

    // Stats: rejected+1, pending-1. A PENDING submission implies an existing
    // stats row; the INSERT is a defensive fallback.
    await tx.$executeRawUnsafe(
      `INSERT INTO user_bounty_stats
         (user_id, total_submissions, pending_submissions, accepted_submissions,
          rejected_submissions, approval_rate, updated_at)
       VALUES ($1, 1, 0, 0, 1, 0, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         rejected_submissions = user_bounty_stats.rejected_submissions + 1,
         pending_submissions  = GREATEST(user_bounty_stats.pending_submissions - 1, 0),
         updated_at = NOW()`,
      userIdBig
    );
    await recomputeApprovalRate(tx, userIdBig);

    return updated[0];
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
  listForUser,
  getById,
  listPendingForAdmin,
  findApprovedUnappliedSiblings,
  getFieldContext,
  reject,
  SubmissionError,
  DEFAULT_DAILY_LIMIT,
};
