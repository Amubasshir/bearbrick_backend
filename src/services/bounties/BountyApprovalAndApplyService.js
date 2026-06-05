'use strict';

// BountyApprovalAndApplyService — Approve+Apply (spec §20.1 extension). Runs the
// shared approval core (reward + balances + monthly-spent + XP + stats), then:
//   1. writes the canonical brick field from the submission content,
//   2. flips the submission to APPLIED_TO_BRICK,
//   3. closes the bounty if the field is now filled,
//   4. fires BRICK_COMPLETED XP for the closing user iff this apply closed the
//      brick's *final* OPEN bounty (Q7).
//
// Unlike Simple Approve, this is the action that mutates canonical brick data.
// It is a terminal action on a PENDING submission — calling it on an
// already-Simple-Approved submission is rejected (would otherwise double-pay,
// since the two reward events carry different idempotency keys).

const prisma = require('../../lib/prisma');
const Inst = require('./BountyInstanceService');
const { insertXpEvent } = require('../../lib/xpEvents');
const { FIELD_MAP, MILESTONE_XP } = require('./bountyTypes');
const { computeLocalDayKey, toDayKeyString } = require('../../lib/sessions');
const {
  runApprovalCore, loadSubmission, lockUser, ApprovalError,
} = require('./BountyApprovalService');

// Columns the canonical brick write is allowed to touch (validate target_field
// against this so the dynamic column name can never be attacker-controlled).
const ALLOWED_COLUMNS = new Set(Object.values(FIELD_MAP).map((m) => m.column));

/** The target brick column for a submission's bounty instance. */
async function loadTargetField(tx, bountyInstanceId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT target_field FROM bounty_instances WHERE id = $1::uuid LIMIT 1`,
    bountyInstanceId
  );
  return rows[0] ? rows[0].target_field : null;
}

/**
 * Approve+Apply. Returns { submission, idempotent, actualCash, creditReward,
 * xpReward, brickClosed, brickCompleted }.
 */
async function approveAndApply(prismaClient, { submissionId, adminUserId = null, now = new Date() }) {
  return (prismaClient || prisma).$transaction(async (tx) => {
    const submission = await loadSubmission(tx, submissionId);
    if (!submission) throw new ApprovalError('submission_not_found');
    await lockUser(tx, BigInt(submission.user_id));

    if (submission.status === 'APPLIED_TO_BRICK') {
      return {
        submission, idempotent: true, actualCash: 0, creditReward: 0, xpReward: 0,
        brickClosed: false, brickCompleted: false,
      };
    }
    if (submission.status !== 'PENDING') {
      throw new ApprovalError('cannot_apply_' + submission.status.toLowerCase());
    }

    const targetField = await loadTargetField(tx, submission.bounty_instance_id);
    if (!targetField || !ALLOWED_COLUMNS.has(targetField)) {
      throw new ApprovalError('invalid_target_field');
    }

    const core = await runApprovalCore(tx, {
      submission,
      eventType: 'BOUNTY_APPROVED_AND_APPLIED',
      idempotencyKey: `bounty_reward:${submission.id}:approved_and_applied`,
      adminUserId,
      now,
    });
    if (core.idempotent) {
      return {
        submission, idempotent: true, actualCash: 0, creditReward: 0, xpReward: 0,
        brickClosed: false, brickCompleted: false,
      };
    }

    // Write the canonical brick field. release_year is the one INTEGER column.
    let value = submission.submission_type === 'IMAGE'
      ? submission.content_url : submission.content_text;
    if (targetField === 'release_year') value = parseInt(value, 10);
    await tx.$executeRawUnsafe(
      `UPDATE bricks SET "${targetField}" = $1, updated_at = NOW() WHERE id = $2`,
      value, submission.brick_id
    );

    const updated = await tx.$queryRawUnsafe(
      `UPDATE bounty_submissions
         SET status = 'APPLIED_TO_BRICK', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1::uuid RETURNING id, status`,
      submission.id, adminUserId != null ? BigInt(adminUserId) : null
    );

    // Close the bounty if the field is now filled, then decide BRICK_COMPLETED.
    const closeRes = await Inst.closeInstanceIfFieldFilled(tx, submission.bounty_instance_id);
    let brickCompleted = false;
    if (closeRes.closed) {
      const open = await Inst.countOpenForBrick(tx, submission.brick_id);
      if (open === 0) {
        const tz = submission.timezone || 'UTC';
        const localDayKey = toDayKeyString(computeLocalDayKey(now, tz));
        await insertXpEvent(tx, {
          userId: BigInt(submission.user_id),
          xpAmount: MILESTONE_XP.BRICK_COMPLETED,
          reason: 'CONTRIBUTION',
          eventType: 'BRICK_COMPLETED',
          sourceSystem: 'm4',
          localDayKey,
          idempotencyKey: `xp:brick_completed:${submission.brick_id}:${submission.user_id}`,
        });
        brickCompleted = true;
      }
    }

    return {
      submission: updated[0],
      idempotent: false,
      actualCash: core.actualCash,
      creditReward: core.creditReward,
      xpReward: core.xpReward,
      brickClosed: closeRes.closed,
      brickCompleted,
    };
  });
}

module.exports = {
  approveAndApply,
};
