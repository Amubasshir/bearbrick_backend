'use strict';

// BountyController — user-facing bounty reads. Thin: parse/validate query
// params, call the service, shape the response into the standard envelope.
// No global error handler exists, so each handler owns its try/catch.

const prisma = require('../../lib/prisma');
const BountyInstanceService = require('../../services/bounties/BountyInstanceService');
const BountySubmissionService = require('../../services/bounties/BountySubmissionService');
const PayoutService = require('../../services/bounties/PayoutService');
const BountyDefinitionService = require('../../services/bounties/BountyDefinitionService');
const { availableCash } = require('../../lib/moneyMath');
const { shapeSubmission } = require('./submissionView');

const VALID_PAYOUT_METHODS = ['PAYPAL', 'VENMO'];

const VALID_STATUSES = ['OPEN', 'CLOSED', 'PAUSED'];

// bricks has no physical "size" column in this codebase (only edition_size,
// a different concept), so size is surfaced as null until a size field exists.
function shapeBounty(r) {
  return {
    id: r.id,
    brickId: r.brick_id,
    brickName: r.brick_name,
    size: null,
    type: r.type,
    description: r.description ?? null,
    rewardCashCents: r.reward_cash_cents,
    rewardCredits: r.reward_credits,
    priority: r.priority,
    status: r.status,
  };
}

// Parse/validate the shared bounty query filters. Returns either
// { error: <message> } or { filters: { type, priority, rewardMin, status } }.
// brickId is supplied by the caller (query param or path), not parsed here.
function parseBountyFilters(query) {
  const { type, priority, status } = query;
  if (status && !VALID_STATUSES.includes(status)) {
    return { error: `status must be one of: ${VALID_STATUSES.join(', ')}.` };
  }
  let rewardMin;
  if (query.reward_min !== undefined) {
    rewardMin = parseInt(query.reward_min, 10);
    if (Number.isNaN(rewardMin)) {
      return { error: 'reward_min must be an integer.' };
    }
  }
  return { filters: { type, priority, rewardMin, status } };
}

/**
 * GET /api/bounties — open bounties with optional filters
 * (type, priority, brick_id, reward_min, status). Public read (optionalAuth).
 */
async function list(req, res) {
  try {
    const parsed = parseBountyFilters(req.query);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const rows = await BountyInstanceService.listOpen({
      ...parsed.filters,
      brickId: req.query.brick_id,
    });
    return res.status(200).json({ success: true, data: { bounties: rows.map(shapeBounty) } });
  } catch (err) {
    console.error('[BountyController.list] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * GET /api/bricks/:brickId/bounties — open bounties for one brick. brickId is an
 * opaque TEXT brick id from the path; other query filters compose on top. Lists
 * bounties only — an unknown brickId yields an empty list, not a 404.
 */
async function listForBrick(req, res) {
  try {
    const parsed = parseBountyFilters(req.query);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const rows = await BountyInstanceService.listOpen({
      ...parsed.filters,
      brickId: req.params.brickId,
    });
    return res.status(200).json({ success: true, data: { bounties: rows.map(shapeBounty) } });
  } catch (err) {
    console.error('[BountyController.listForBrick] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * GET /api/me/bounty-submissions — the authenticated caller's own submission
 * history, newest-first. Requires auth; strictly scoped to req.user.id.
 */
async function myList(req, res) {
  try {
    const rows = await BountySubmissionService.listForUser(req.user.id);
    return res.status(200).json({ success: true, data: { submissions: rows.map(shapeSubmission) } });
  } catch (err) {
    console.error('[BountyController.myList] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * GET /api/me/balances — the authenticated caller's cash/credit balances plus
 * derived availableCashCents (= cash - reserved via moneyMath). Requires auth;
 * scoped to req.user.id. A missing balance row is treated as a zeroed balance
 * (defensive — every real account has a row from signup).
 */
async function myBalances(req, res) {
  try {
    const bal = await PayoutService.getBalanceForUser(req.user.id);
    const cashBalanceCents = bal ? bal.cash_balance_cents : 0;
    const reservedCashCents = bal ? bal.reserved_cash_cents : 0;
    return res.status(200).json({
      success: true,
      data: {
        cashBalanceCents,
        reservedCashCents,
        availableCashCents: availableCash(cashBalanceCents, reservedCashCents),
        creditBalance: bal ? bal.credit_balance : 0,
        lifetimeCashEarnedCents: bal ? bal.lifetime_cash_earned_cents : 0,
        lifetimeCreditsEarned: bal ? bal.lifetime_credits_earned : 0,
      },
    });
  } catch (err) {
    console.error('[BountyController.myBalances] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

// Map a BountySubmissionService.SubmissionError code to an HTTP response. Field
// validation codes carry an `errors` object; the rest are single-message.
function submissionErrorResponse(code) {
  if (code === 'email_not_verified' || (code && code.startsWith('account_'))) {
    return {
      status: 403,
      body: {
        success: false,
        message:
          code === 'email_not_verified'
            ? 'Email verification is required to submit.'
            : 'Your account is not permitted to submit.',
      },
    };
  }
  if (code === 'daily_limit_reached') {
    return {
      status: 429,
      body: { success: false, message: 'Daily submission limit reached. Try again after the daily reset.' },
    };
  }
  if (code === 'bounty_not_found' || code === 'user_not_found') {
    return { status: 404, body: { success: false, message: 'Bounty not found.' } };
  }
  if (code === 'bounty_paused') {
    return { status: 409, body: { success: false, message: 'This bounty is not currently accepting submissions.' } };
  }
  const FIELD_ERRORS = {
    invalid_submission_type: { submissionType: ['Must be IMAGE or DATA.'] },
    missing_content_url: { contentUrl: ['Required for an IMAGE submission.'] },
    missing_content_text: { contentText: ['Required for a DATA submission.'] },
  };
  if (FIELD_ERRORS[code]) {
    return { status: 422, body: { success: false, message: 'Validation error', errors: FIELD_ERRORS[code] } };
  }
  return null; // unknown code -> caller falls through to 500
}

/**
 * POST /api/bounties/:bountyInstanceId/submissions — submission entry point.
 * Thin mapping over BountySubmissionService.submit (which owns the account-state
 * gate, IMAGE email-verify gate, 10/day limit, reward capture, and CLOSED
 * auto-reject). New PENDING row -> 201; CLOSED auto-reject returns a REJECTED
 * row -> 200 (well-formed request, system resolved it as designed).
 */
async function createSubmission(req, res) {
  try {
    const { submissionType, contentUrl, contentText, sourceUrl, notes } = req.body || {};
    const created = await BountySubmissionService.submit(prisma, {
      userId: req.user.id,
      bountyInstanceId: req.params.bountyInstanceId,
      submissionType,
      contentUrl,
      contentText,
      sourceUrl,
      notes,
    });

    const full = await BountySubmissionService.getById(created.id);
    const httpStatus = created.status === 'PENDING' ? 201 : 200;
    return res.status(httpStatus).json({ success: true, data: { submission: shapeSubmission(full) } });
  } catch (err) {
    if (err instanceof BountySubmissionService.SubmissionError) {
      const mapped = submissionErrorResponse(err.code);
      if (mapped) return res.status(mapped.status).json(mapped.body);
    }
    console.error('[BountyController.createSubmission] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

// Shape a payout_requests row for the caller (camelCase, user-facing fields).
function shapePayoutRequest(r) {
  return {
    id: r.id,
    amountCents: r.amount_cents,
    payoutMethod: r.payout_method,
    payoutHandle: r.payout_handle,
    status: r.status,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    paidAt: r.paid_at,
  };
}

/**
 * POST /api/me/payout-requests — request a payout of available cash. Thin over
 * PayoutService.request (which enforces min-payout, available-balance, reserve,
 * and multiple-pending). amountCents must be a positive integer (validated here
 * because PayoutService.assertCents throws a generic Error, not a PayoutError).
 * payoutHandle defaults to the caller's profile handle for the chosen method.
 */
async function createPayoutRequest(req, res) {
  try {
    const { amountCents, payoutMethod } = req.body || {};

    const errors = {};
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      errors.amountCents = ['Must be a positive integer number of cents.'];
    }
    if (!VALID_PAYOUT_METHODS.includes(payoutMethod)) {
      errors.payoutMethod = [`Must be one of: ${VALID_PAYOUT_METHODS.join(', ')}.`];
    }
    if (Object.keys(errors).length) {
      return res.status(422).json({ success: false, message: 'Validation error', errors });
    }

    // Resolve the payout handle: explicit body value, else the profile default
    // for the chosen method. Never submit a null destination.
    const profileDefault = payoutMethod === 'PAYPAL' ? req.user.paypalHandle : req.user.venmoHandle;
    const payoutHandle = req.body.payoutHandle || profileDefault || null;
    if (!payoutHandle) {
      return res.status(422).json({
        success: false,
        message: 'Validation error',
        errors: { payoutHandle: [`Required — no default on file for ${payoutMethod}.`] },
      });
    }

    let pr;
    try {
      pr = await PayoutService.request(prisma, {
        userId: req.user.id,
        amountCents,
        payoutMethod,
        payoutHandle,
      });
    } catch (err) {
      if (err instanceof PayoutService.PayoutError) {
        if (err.code === 'below_minimum_payout') {
          const settings = await BountyDefinitionService.getAdminSettings();
          return res.status(422).json({
            success: false,
            message: 'Validation error',
            errors: { amountCents: [`Minimum payout is ${settings.minimumPayoutCents} cents.`] },
          });
        }
        if (err.code === 'insufficient_available_cash') {
          const bal = await PayoutService.getBalanceForUser(req.user.id);
          const available = bal ? availableCash(bal.cash_balance_cents, bal.reserved_cash_cents) : 0;
          return res.status(409).json({
            success: false,
            message: `Insufficient available balance. Available: ${available} cents.`,
          });
        }
        if (err.code === 'invalid_amount') {
          return res.status(422).json({
            success: false, message: 'Validation error',
            errors: { amountCents: ['Must be a positive integer number of cents.'] },
          });
        }
        if (err.code === 'invalid_payout_method') {
          return res.status(422).json({
            success: false, message: 'Validation error',
            errors: { payoutMethod: [`Must be one of: ${VALID_PAYOUT_METHODS.join(', ')}.`] },
          });
        }
        if (err.code === 'missing_payout_handle') {
          return res.status(422).json({
            success: false, message: 'Validation error',
            errors: { payoutHandle: ['Required.'] },
          });
        }
      }
      throw err;
    }

    return res.status(201).json({ success: true, data: { payoutRequest: shapePayoutRequest(pr) } });
  } catch (err) {
    console.error('[BountyController.createPayoutRequest] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

module.exports = {
  list, listForBrick, myList, myBalances, createSubmission, createPayoutRequest,
};
