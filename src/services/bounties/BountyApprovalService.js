'use strict';

// BountyApprovalService — the atomic Simple-Approve transaction (spec §20.1).
// Runs in one transaction under a per-user advisory lock. Simple Approve mints
// the reward and flips the submission to APPROVED but does NOT close the bounty
// (Approve+Apply does — see BountyApprovalAndApplyService).
//
// Determinism (C3): reward amounts are read from the *captured* submission row
// (cash_reward_cents / credit_reward / xp_reward), never re-derived from
// bounty_definitions. The monthly budget cap is a separately-tracked approval-time
// gate that only zeroes the *cash* leg (Q6) — credits + XP are always paid in full.
//
// Idempotency: the whole approval is guarded by the bounty_reward_events
// idempotency_key (`bounty_reward:{submission_id}:approved`, ON CONFLICT DO
// NOTHING). A pre-check on submission.status short-circuits the common retry.

const prisma = require('../../lib/prisma');
const BountyDefinitionService = require('./BountyDefinitionService');
const { insertXpEvent } = require('../../lib/xpEvents');
const { MILESTONE_XP } = require('./bountyTypes');
const { computeLocalDayKey, toDayKeyString } = require('../../lib/sessions');

class ApprovalError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

const SUBMISSION_SELECT = `
  bs.id, bs.user_id, bs.brick_id, bs.bounty_instance_id, bs.status,
  bs.submission_type, bs.content_url, bs.content_path, bs.content_text,
  bs.cash_reward_cents, bs.credit_reward, bs.xp_reward, u.timezone`;

/** Load the submission joined to its user (for timezone / local_day_key). */
async function loadSubmission(tx, submissionId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${SUBMISSION_SELECT}
       FROM bounty_submissions bs JOIN "User" u ON u.id = bs.user_id
      WHERE bs.id = $1::uuid LIMIT 1`,
    submissionId
  );
  return rows[0] || null;
}

/** Per-user advisory lock for the duration of the transaction. */
async function lockUser(tx, userIdBig) {
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext('bounty_approve:' || $1)::bigint)`,
    userIdBig.toString()
  );
}

/**
 * The shared 15-step approval core (spec §20.1), reused by Approve+Apply.
 * Writes the reward ledger, balances, monthly-spent, XP, stats, and milestone
 * XP. Returns { idempotent, actualCash, creditReward, xpReward, newAccepted }.
 * The caller flips submission.status and (for apply) does the brick write.
 */
async function runApprovalCore(tx, { submission, eventType, idempotencyKey, adminUserId, now }) {
  const userIdBig = BigInt(submission.user_id);
  const capturedCash = submission.cash_reward_cents;
  const capturedCredits = submission.credit_reward;
  const capturedXp = submission.xp_reward;

  // Budget cap (Q6/C3): cash is zeroed if disabled or it would breach the cap;
  // credits + XP are always full.
  const settings = await BountyDefinitionService.getAdminSettings(tx);
  const withinBudget = settings.monthlyCashSpentCents + capturedCash <= settings.monthlyCashBudgetCents;
  const actualCash = settings.cashRewardsEnabled && withinBudget ? capturedCash : 0;

  // 1. Reward ledger — the idempotency gate for the whole approval.
  const ledger = await tx.$queryRawUnsafe(
    `INSERT INTO bounty_reward_events
       (user_id, bounty_submission_id, cash_delta_cents, credit_delta, xp_delta,
        event_type, idempotency_key, created_by)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    userIdBig, submission.id, actualCash, capturedCredits, capturedXp,
    eventType, idempotencyKey, adminUserId != null ? BigInt(adminUserId) : null
  );
  if (ledger.length === 0) {
    return { idempotent: true, actualCash: 0, creditReward: 0, xpReward: 0, newAccepted: null };
  }

  // 2. Balances (+actualCash cash, +credits, +lifetime). Upsert so a missing
  //    balance row (test users) is created rather than silently skipped.
  await tx.$executeRawUnsafe(
    `INSERT INTO user_balances
       (user_id, cash_balance_cents, reserved_cash_cents, credit_balance,
        lifetime_cash_earned_cents, lifetime_credits_earned)
     VALUES ($1, $2, 0, $3, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       cash_balance_cents         = user_balances.cash_balance_cents + $2,
       credit_balance             = user_balances.credit_balance + $3,
       lifetime_cash_earned_cents = user_balances.lifetime_cash_earned_cents + $2,
       lifetime_credits_earned    = user_balances.lifetime_credits_earned + $3,
       updated_at = NOW()`,
    userIdBig, actualCash, capturedCredits
  );

  // 3. Monthly cash spent (only the cash that was actually paid).
  if (actualCash !== 0) {
    await tx.$executeRawUnsafe(
      `UPDATE admin_settings SET value = ((value)::int + $1)::text, updated_at = NOW()
       WHERE key = 'monthly_cash_spent_cents'`,
      actualCash
    );
  }

  const tz = submission.timezone || 'UTC';
  const localDayKey = toDayKeyString(computeLocalDayKey(now, tz));

  // 4. Bounty XP (confirmed), via the shared minting helper.
  await insertXpEvent(tx, {
    userId: userIdBig,
    xpAmount: capturedXp,
    reason: 'CONTRIBUTION',
    eventType: 'BOUNTY_SUBMISSION_APPROVED',
    sourceSystem: 'm4',
    localDayKey,
    idempotencyKey: `xp:bounty_approved:${submission.id}`,
  });

  // 5. Stats: accepted +1, pending -1, recompute approval_rate. Upsert defensive.
  let newAccepted;
  const upd = await tx.$queryRawUnsafe(
    `UPDATE user_bounty_stats SET
       accepted_submissions = accepted_submissions + 1,
       pending_submissions  = GREATEST(pending_submissions - 1, 0),
       approval_rate = ROUND((accepted_submissions + 1)::numeric
                       / ((accepted_submissions + 1) + rejected_submissions), 2),
       updated_at = NOW()
     WHERE user_id = $1
     RETURNING accepted_submissions`,
    userIdBig
  );
  if (upd.length > 0) {
    newAccepted = upd[0].accepted_submissions;
  } else {
    await tx.$executeRawUnsafe(
      `INSERT INTO user_bounty_stats
         (user_id, total_submissions, accepted_submissions, approval_rate, updated_at)
       VALUES ($1, 1, 1, 1, NOW())`,
      userIdBig
    );
    newAccepted = 1;
  }

  // 6. Milestone XP (once each, idempotent via xp_idempotency_keys).
  if (newAccepted === 1) {
    await insertXpEvent(tx, {
      userId: userIdBig,
      xpAmount: MILESTONE_XP.FIRST_APPROVED_BOUNTY,
      reason: 'CONTRIBUTION',
      eventType: 'FIRST_APPROVED_BOUNTY',
      sourceSystem: 'm4',
      localDayKey,
      idempotencyKey: `xp:bounty_first:${userIdBig.toString()}`,
    });
  }
  if (newAccepted === 10) {
    await insertXpEvent(tx, {
      userId: userIdBig,
      xpAmount: MILESTONE_XP.TEN_APPROVED_BOUNTIES,
      reason: 'CONTRIBUTION',
      eventType: 'TEN_APPROVED_BOUNTIES',
      sourceSystem: 'm4',
      localDayKey,
      idempotencyKey: `xp:bounty_ten:${userIdBig.toString()}`,
    });
  }

  return {
    idempotent: false,
    actualCash,
    creditReward: capturedCredits,
    xpReward: capturedXp,
    newAccepted,
  };
}

/**
 * Simple Approve: mint reward + flip to APPROVED. Bounty stays OPEN.
 * Returns { submission, idempotent, actualCash, creditReward, xpReward }.
 */
async function approve(prismaClient, { submissionId, adminUserId = null, now = new Date() }) {
  return (prismaClient || prisma).$transaction(async (tx) => {
    const submission = await loadSubmission(tx, submissionId);
    if (!submission) throw new ApprovalError('submission_not_found');
    await lockUser(tx, BigInt(submission.user_id));

    if (submission.status === 'APPROVED' || submission.status === 'APPLIED_TO_BRICK') {
      return { submission, idempotent: true, actualCash: 0, creditReward: 0, xpReward: 0 };
    }
    if (submission.status !== 'PENDING') {
      throw new ApprovalError('cannot_approve_' + submission.status.toLowerCase());
    }

    const core = await runApprovalCore(tx, {
      submission,
      eventType: 'BOUNTY_APPROVED',
      idempotencyKey: `bounty_reward:${submission.id}:approved`,
      adminUserId,
      now,
    });
    if (core.idempotent) return { submission, idempotent: true, actualCash: 0, creditReward: 0, xpReward: 0 };

    const updated = await tx.$queryRawUnsafe(
      `UPDATE bounty_submissions
         SET status = 'APPROVED', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1::uuid RETURNING id, status`,
      submission.id, adminUserId != null ? BigInt(adminUserId) : null
    );

    return {
      submission: updated[0],
      idempotent: false,
      actualCash: core.actualCash,
      creditReward: core.creditReward,
      xpReward: core.xpReward,
    };
  });
}

module.exports = {
  approve,
  runApprovalCore,
  loadSubmission,
  lockUser,
  ApprovalError,
};
