'use strict';

// Shared view-shaper for a bounty_submissions row (camelCase). Used by the user
// submission feed (GET/POST /me/... and POST .../submissions) and the admin
// approve/reject responses, so every endpoint returns an identical submission
// shape. Dates are left as Date values — res.json serializes them to ISO strings.
function shapeSubmission(r) {
  return {
    id: r.id,
    bountyInstanceId: r.bounty_instance_id,
    brickId: r.brick_id,
    submissionType: r.submission_type,
    status: r.status,
    rewardCashCents: r.cash_reward_cents,
    rewardCredits: r.credit_reward,
    rewardXp: r.xp_reward,
    contentUrl: r.content_url,
    contentText: r.content_text,
    sourceUrl: r.source_url,
    notes: r.notes,
    rejectionReasons: r.rejection_reasons,
    adminNotes: r.admin_notes,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
  };
}

/**
 * Duplicate-field advisory descriptor (Unit B2), shared so the review queue and
 * the approve echoes emit an identical shape. Given the sibling submission ids
 * from BountySubmissionService.findApprovedUnappliedSiblings: warning true iff
 * any exist, with a descriptor carrying the count + ids; false + null descriptor
 * when none.
 */
function buildDuplicateFieldWarning(siblingIds) {
  const ids = Array.isArray(siblingIds) ? siblingIds : [];
  const has = ids.length > 0;
  return {
    duplicateFieldWarning: has,
    duplicateFieldSiblings: has ? { count: ids.length, submissionIds: ids } : null,
  };
}

module.exports = { shapeSubmission, buildDuplicateFieldWarning };
