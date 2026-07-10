'use strict';

// AdminBountyController — admin-facing bounty endpoints. Thin: parse query ->
// call the service -> shape the envelope. Auth is enforced by the route's
// adminAuth + requirePermission middleware, not here.

const prisma = require('../../lib/prisma');
const BountySubmissionService = require('../../services/bounties/BountySubmissionService');
const BountyApprovalService = require('../../services/bounties/BountyApprovalService');
const BountyApprovalAndApplyService = require('../../services/bounties/BountyApprovalAndApplyService');
const BountyInstanceService = require('../../services/bounties/BountyInstanceService');
const BountyDefinitionService = require('../../services/bounties/BountyDefinitionService');
const PayoutService = require('../../services/bounties/PayoutService');
const { shapeSubmission, buildDuplicateFieldWarning } = require('../bounties/submissionView');
const { shapeInstance } = require('../bounties/instanceView');

// Admin payout view — cross-user, so it exposes userId + the reviewer/notes the
// admin needs (distinct from the user-facing shapePayoutRequest in BountyController,
// which must NOT leak the reviewing admin's id or notes to the requester). BIGINT
// ids are stringified, matching shapeQueueItem.
function shapeAdminPayout(r) {
  return {
    id: r.id,
    userId: String(r.user_id),
    amountCents: r.amount_cents,
    payoutMethod: r.payout_method,
    payoutHandle: r.payout_handle,
    status: r.status,
    adminNotes: r.admin_notes,
    reviewedBy: r.reviewed_by != null ? String(r.reviewed_by) : null,
    reviewedAt: r.reviewed_at,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  };
}

const PRIORITY_VALUES = new Set(['LOW', 'MEDIUM', 'HIGH']);

// Inlined (3.7 is the only definition-shaping endpoint — a shared view file would
// be overkill). Read-only fields (type/displayName/description) are echoed but not
// editable. camelCase, matching the other bounty view shapers.
function shapeDefinition(r) {
  return {
    id: r.id,
    type: r.type,
    displayName: r.display_name,
    description: r.description,
    rewardCashCents: r.reward_cash_cents,
    rewardCredits: r.reward_credits,
    priority: r.priority,
    isActive: r.is_active,
  };
}

const PAGE_SIZE = 50;

// Admin queue item — cross-user, so userId IS exposed (unlike the user feed).
// Carries the Unit B2 duplicate-field advisory (siblingIds from the shared
// findApprovedUnappliedSiblings primitive).
function shapeQueueItem(r, siblingIds = []) {
  return {
    id: r.id,
    bountyInstanceId: r.bounty_instance_id,
    brickId: r.brick_id,
    userId: String(r.user_id),
    bountyType: r.bounty_type,
    submissionType: r.submission_type,
    status: r.status,
    contentUrl: r.content_url,
    contentText: r.content_text,
    sourceUrl: r.source_url,
    notes: r.notes,
    rewardCashCents: r.cash_reward_cents,
    rewardCredits: r.credit_reward,
    rewardXp: r.xp_reward,
    createdAt: r.created_at,
    ...buildDuplicateFieldWarning(siblingIds),
  };
}

// Build the shared success payload for an approve/approve-without-applying
// response: the shaped submission plus the Unit B2 duplicate-field echo (siblings
// for the submission's brick+field, self excluded). Advisory only — the caller
// has already succeeded; this never affects the outcome.
async function approvedResponseData(submissionId) {
  const full = await BountySubmissionService.getById(submissionId);
  const ctx = await BountySubmissionService.getFieldContext(prisma, submissionId);
  const siblingIds = ctx
    ? await BountySubmissionService.findApprovedUnappliedSiblings(prisma, {
      brickId: ctx.brickId,
      targetField: ctx.targetField,
      excludeSubmissionId: submissionId,
    })
    : [];
  return { submission: shapeSubmission(full), ...buildDuplicateFieldWarning(siblingIds) };
}

/**
 * GET /api/admin/bounty-submissions — review queue: PENDING only, oldest-first,
 * filter by bounty_type + brick_id, paginated at 50.
 */
async function submissionQueue(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;
    const rows = await BountySubmissionService.listPendingForAdmin({
      bountyType: req.query.bounty_type,
      brickId: req.query.brick_id,
      limit: PAGE_SIZE,
      offset,
    });
    // Duplicate-field advisory (Unit B2): flag any PENDING item whose brick+field
    // already has an APPROVED-but-unapplied sibling. Reuses the canonical
    // findApprovedUnappliedSiblings primitive per row so the queue and the approve
    // echoes compute the signal identically. Per-row is acceptable: the queue caps
    // at 50 and each lookup is a single indexed read; reusing the primitive (vs. a
    // bespoke set-based join) keeps a single source of truth for the rule.
    const submissions = [];
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      const siblingIds = await BountySubmissionService.findApprovedUnappliedSiblings(prisma, {
        brickId: r.brick_id,
        targetField: r.target_field,
        excludeSubmissionId: r.id,
      });
      submissions.push(shapeQueueItem(r, siblingIds));
    }
    return res.status(200).json({
      success: true,
      data: { submissions, page, pageSize: PAGE_SIZE },
    });
  } catch (err) {
    console.error('[AdminBountyController.submissionQueue] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * POST /api/admin/bounty-submissions/:id/approve — plain approve: mint the
 * reward + flip to APPROVED. The bounty instance stays OPEN (Approve+Apply is
 * the one that closes it). Thin over BountyApprovalService.approve, which is
 * idempotent on re-approve and budget-caps only the cash leg.
 */
async function approve(req, res) {
  try {
    const result = await BountyApprovalService.approve(prisma, {
      submissionId: req.params.id,
      adminUserId: req.user ? req.user.id : null,
    });
    const data = await approvedResponseData(result.submission.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    if (err instanceof BountyApprovalService.ApprovalError) {
      if (err.code === 'submission_not_found') {
        return res.status(404).json({ success: false, message: 'Submission not found.' });
      }
      if (err.code.startsWith('cannot_approve_')) {
        const state = err.code.replace('cannot_approve_', '');
        return res.status(409).json({ success: false, message: `Cannot approve a ${state} submission.` });
      }
    }
    console.error('[AdminBountyController.approve] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * POST /api/admin/bounty-submissions/:id/approve-without-applying — the explicit
 * plain-approve action ("reward now, verify, apply later"). Same reward semantics
 * as /approve (delegates to BountyApprovalService.approve): mints the reward and
 * flips to APPROVED, but deliberately does NOT write the canonical brick field or
 * close the bounty — the instance stays OPEN. Distinctly named so it can evolve
 * independently of /approve.
 */
async function approveWithoutApplying(req, res) {
  try {
    const result = await BountyApprovalService.approve(prisma, {
      submissionId: req.params.id,
      adminUserId: req.user ? req.user.id : null,
    });
    const data = await approvedResponseData(result.submission.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    if (err instanceof BountyApprovalService.ApprovalError) {
      if (err.code === 'submission_not_found') {
        return res.status(404).json({ success: false, message: 'Submission not found.' });
      }
      if (err.code.startsWith('cannot_approve_')) {
        const state = err.code.replace('cannot_approve_', '');
        return res.status(409).json({ success: false, message: `Cannot approve a ${state} submission.` });
      }
    }
    console.error('[AdminBountyController.approveWithoutApplying] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * POST /api/admin/bounty-submissions/:id/approve-and-apply — reward (PENDING
 * only) + write the canonical brick field + close the bounty. Idempotent-aware:
 * already-APPROVED applies without a second reward; already-APPLIED is a no-op.
 * Thin over BountyApprovalAndApplyService.approveAndApply.
 */
async function approveAndApply(req, res) {
  try {
    const result = await BountyApprovalAndApplyService.approveAndApply(prisma, {
      submissionId: req.params.id,
      adminUserId: req.user ? req.user.id : null,
    });
    const full = await BountySubmissionService.getById(result.submission.id);
    return res.status(200).json({ success: true, data: { submission: shapeSubmission(full) } });
  } catch (err) {
    if (err instanceof BountyApprovalService.ApprovalError) {
      if (err.code === 'submission_not_found') {
        return res.status(404).json({ success: false, message: 'Submission not found.' });
      }
      if (err.code === 'invalid_target_field') {
        return res.status(422).json({ success: false, message: 'This bounty has no valid target field.' });
      }
      if (err.code.startsWith('cannot_apply_')) {
        const state = err.code.replace('cannot_apply_', '');
        return res.status(409).json({ success: false, message: `Cannot apply a ${state} submission.` });
      }
    }
    console.error('[AdminBountyController.approveAndApply] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * POST /api/admin/bounty-submissions/:id/reject — reject a PENDING submission
 * with reasons + optional admin notes. No reward, no XP, bounty stays OPEN.
 * Thin over BountySubmissionService.reject.
 */
async function reject(req, res) {
  try {
    const { rejectionReasons, adminNotes } = req.body || {};
    const valid = Array.isArray(rejectionReasons)
      && rejectionReasons.length > 0
      && rejectionReasons.every((r) => typeof r === 'string' && r.trim());
    if (!valid) {
      return res.status(422).json({
        success: false,
        message: 'Validation error',
        errors: { rejectionReasons: ['At least one non-empty rejection reason is required.'] },
      });
    }

    const result = await BountySubmissionService.reject(prisma, {
      submissionId: req.params.id,
      rejectionReasons: rejectionReasons.map(String),
      adminNotes: adminNotes != null ? String(adminNotes) : null,
      adminUserId: req.user ? req.user.id : null,
    });
    const full = await BountySubmissionService.getById(result.id);
    return res.status(200).json({ success: true, data: { submission: shapeSubmission(full) } });
  } catch (err) {
    if (err instanceof BountySubmissionService.SubmissionError) {
      if (err.code === 'submission_not_found') {
        return res.status(404).json({ success: false, message: 'Submission not found.' });
      }
      if (err.code.startsWith('cannot_reject_')) {
        const state = err.code.replace('cannot_reject_', '');
        return res.status(409).json({ success: false, message: `Cannot reject a ${state} submission.` });
      }
    }
    console.error('[AdminBountyController.reject] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * POST /api/admin/bounties — manually create one OPEN bounty for a brick + type.
 * Thin over BountyInstanceService.createManual (which derives target_field from
 * the definition's FIELD_MAP and is idempotent-guarded by the unique_open_bounty
 * partial index). created_by is the 'ADMIN' source marker (mirrors the generator's
 * 'SYSTEM'; the column is a TEXT marker, not a user FK).
 */
async function createBounty(req, res) {
  try {
    const { brickId, type } = req.body || {};
    const errors = {};
    if (!brickId || typeof brickId !== 'string') errors.brickId = ['A brickId is required.'];
    if (!type || typeof type !== 'string') errors.type = ['A bounty type is required.'];
    if (Object.keys(errors).length) {
      return res.status(422).json({ success: false, message: 'Validation error', errors });
    }

    const instance = await BountyInstanceService.createManual(prisma, { brickId, type, createdBy: 'ADMIN' });
    return res.status(201).json({ success: true, data: { instance: shapeInstance(instance) } });
  } catch (err) {
    if (err instanceof BountyInstanceService.InstanceError) {
      if (err.code === 'brick_not_found') {
        return res.status(404).json({ success: false, message: 'Brick not found.' });
      }
      if (err.code === 'definition_not_found') {
        return res.status(404).json({ success: false, message: 'Bounty type not found.' });
      }
      if (err.code === 'definition_inactive') {
        return res.status(422).json({ success: false, message: 'This bounty type is inactive.' });
      }
      if (err.code === 'invalid_bounty_type') {
        return res.status(422).json({ success: false, message: 'Unknown bounty type.' });
      }
      if (err.code === 'duplicate_open_bounty') {
        return res.status(409).json({ success: false, message: 'An open bounty for this brick and field already exists.' });
      }
    }
    console.error('[AdminBountyController.createBounty] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * PATCH /api/admin/bounty-definitions/:id — adjust rewards / pause a bounty type
 * globally. PATCH partial semantics (only provided fields change). Editable set:
 * rewardCashCents, rewardCredits (non-negative integer cents), priority
 * (LOW|MEDIUM|HIGH — the derived-XP lever), isActive (boolean, global pause). Any
 * non-editable key (e.g. `type`) is rejected 422 so a client can never silently
 * believe it changed an identity/derivation field. Forward-only: never touches
 * already-captured submission rewards. Thin over BountyDefinitionService.update.
 */
async function updateDefinition(req, res) {
  try {
    const body = req.body || {};
    const errors = {};
    const patch = {};

    for (const key of Object.keys(body)) {
      if (!(key in BountyDefinitionService.EDITABLE_COLUMN_MAP)) {
        errors[key] = ['This field is not editable.'];
      }
    }

    if (body.rewardCashCents !== undefined) {
      if (!Number.isInteger(body.rewardCashCents) || body.rewardCashCents < 0) {
        errors.rewardCashCents = ['Must be a non-negative integer number of cents.'];
      } else patch.rewardCashCents = body.rewardCashCents;
    }
    if (body.rewardCredits !== undefined) {
      if (!Number.isInteger(body.rewardCredits) || body.rewardCredits < 0) {
        errors.rewardCredits = ['Must be a non-negative integer.'];
      } else patch.rewardCredits = body.rewardCredits;
    }
    if (body.priority !== undefined) {
      if (!PRIORITY_VALUES.has(body.priority)) {
        errors.priority = ['Must be one of LOW, MEDIUM, HIGH.'];
      } else patch.priority = body.priority;
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') {
        errors.isActive = ['Must be a boolean.'];
      } else patch.isActive = body.isActive;
    }

    if (Object.keys(errors).length) {
      return res.status(422).json({ success: false, message: 'Validation error', errors });
    }
    if (Object.keys(patch).length === 0) {
      return res.status(422).json({
        success: false,
        message: 'Validation error',
        errors: { _body: ['At least one editable field is required.'] },
      });
    }

    const updated = await BountyDefinitionService.update(prisma, req.params.id, patch);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Bounty definition not found.' });
    }
    return res.status(200).json({ success: true, data: { definition: shapeDefinition(updated) } });
  } catch (err) {
    console.error('[AdminBountyController.updateDefinition] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * PATCH /api/admin/bounty-instances/:id — pause / close / reopen a specific
 * instance. Request shape {status: OPEN|PAUSED|CLOSED} (direct target status).
 * Thin over BountyInstanceService.transition, which owns the state machine and
 * lets the unique_open_bounty index arbitrate reopen collisions. Reuses the 3.6
 * shapeInstance for the response.
 */
async function updateInstance(req, res) {
  try {
    const { status } = req.body || {};
    if (!status || typeof status !== 'string' || !BountyInstanceService.STATUS_VALUES.has(status)) {
      return res.status(422).json({
        success: false,
        message: 'Validation error',
        errors: { status: ['Must be one of OPEN, PAUSED, CLOSED.'] },
      });
    }

    const updated = await BountyInstanceService.transition(prisma, req.params.id, status);
    return res.status(200).json({ success: true, data: { instance: shapeInstance(updated) } });
  } catch (err) {
    if (err instanceof BountyInstanceService.InstanceError) {
      if (err.code === 'instance_not_found') {
        return res.status(404).json({ success: false, message: 'Bounty instance not found.' });
      }
      if (err.code === 'illegal_transition') {
        return res.status(422).json({ success: false, message: 'That status transition is not allowed.' });
      }
      if (err.code === 'duplicate_open_bounty') {
        return res.status(409).json({ success: false, message: 'Cannot reopen — another open bounty already covers this brick field.' });
      }
    }
    console.error('[AdminBountyController.updateInstance] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * GET /api/admin/payout-requests — cross-user payout queue: REQUESTED-first then
 * oldest-first, filter by status + user_id, paginated at 50. Read-only. Thin over
 * PayoutService.listForAdmin.
 */
async function payoutQueue(req, res) {
  try {
    const { status, user_id: userId } = req.query;
    if (status !== undefined && !PayoutService.VALID_STATUSES.has(status)) {
      return res.status(422).json({
        success: false,
        message: 'Validation error',
        errors: { status: ['Must be one of REQUESTED, APPROVED, PAID, REJECTED.'] },
      });
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;
    const rows = await PayoutService.listForAdmin({ status, userId, limit: PAGE_SIZE, offset });
    return res.status(200).json({
      success: true,
      data: { payoutRequests: rows.map(shapeAdminPayout), page, pageSize: PAGE_SIZE },
    });
  } catch (err) {
    console.error('[AdminBountyController.payoutQueue] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

const PAYOUT_ACTIONS = new Set(['approve', 'mark_paid', 'reject']);

/**
 * PATCH /api/admin/payout-requests/:id — approve / mark_paid / reject. Thin action
 * dispatcher over the Phase A PayoutService state machine (reserve accounting +
 * idempotent mark-paid + advisory locks all live there — NO payout logic here).
 * Body {action, notes?}; reject notes optional. Idempotent no-ops (already in the
 * target state) return 200 (not 409), mirroring the bounty approve endpoints.
 * Actor recorded as null under X-Admin-Secret (PayoutService/3.5 precedent).
 * Reuses shapeAdminPayout; re-fetches the full row so the idempotent (partial-row)
 * path shapes identically to the success path.
 */
async function updatePayout(req, res) {
  try {
    const { action, notes } = req.body || {};
    if (!PAYOUT_ACTIONS.has(action)) {
      return res.status(422).json({
        success: false,
        message: 'Validation error',
        errors: { action: ['Must be one of approve, mark_paid, reject.'] },
      });
    }

    const payoutRequestId = req.params.id;
    const adminUserId = req.user ? req.user.id : null;

    let result;
    if (action === 'approve') {
      result = await PayoutService.approve(prisma, { payoutRequestId, adminUserId });
    } else if (action === 'mark_paid') {
      result = await PayoutService.markPaid(prisma, { payoutRequestId, adminUserId });
    } else {
      result = await PayoutService.reject(prisma, {
        payoutRequestId, adminUserId, notes: notes != null ? String(notes) : null,
      });
    }

    const full = await PayoutService.getById(result.payout.id);
    return res.status(200).json({ success: true, data: { payoutRequest: shapeAdminPayout(full) } });
  } catch (err) {
    if (err instanceof PayoutService.PayoutError) {
      if (err.code === 'payout_not_found') {
        return res.status(404).json({ success: false, message: 'Payout request not found.' });
      }
      if (err.code.startsWith('cannot_')) {
        return res.status(409).json({ success: false, message: 'This payout cannot be updated from its current state.' });
      }
    }
    console.error('[AdminBountyController.updatePayout] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

module.exports = {
  submissionQueue, approve, approveWithoutApplying, approveAndApply, reject,
  createBounty, updateDefinition, updateInstance, payoutQueue, updatePayout,
};
