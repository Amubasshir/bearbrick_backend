'use strict';

// PayoutService — the payout-request state machine (spec §17.6 / §21).
//   REQUESTED -> APPROVED -> PAID   (or -> REJECTED from REQUESTED/APPROVED)
//
// Reserved-cash accounting lives on user_balances: `request` reserves the amount
// (multiple pending requests allowed, each reserves separately — Q10); `markPaid`
// decrements both cash and reserved; `reject` releases the reserve. Every
// transition writes an immutable payout_action_events row (Global Rule 10).
//
// Mark-Paid idempotency (Q9): the `paid_at IS NULL` guard inside the locked
// transaction + the `payout_paid:{id}` idempotency key make a double Mark-Paid a
// no-op. Per-(user, payout) advisory lock serializes concurrent transitions.

const prisma = require('../../lib/prisma');
const BountyDefinitionService = require('./BountyDefinitionService');
const { assertCents } = require('../../lib/moneyMath');

class PayoutError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PayoutError';
    this.code = code;
  }
}

const VALID_METHODS = new Set(['PAYPAL', 'VENMO']);

async function lockUser(tx, userIdBig) {
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext('payout_user:' || $1)::bigint)`,
    userIdBig.toString()
  );
}

async function lockUserPayout(tx, userIdBig, payoutId) {
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext('payout:' || $1 || ':' || $2)::bigint)`,
    userIdBig.toString(), payoutId
  );
}

async function loadPayout(tx, payoutRequestId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, user_id, amount_cents, status, paid_at, payout_method, payout_handle
       FROM payout_requests WHERE id = $1::uuid LIMIT 1`,
    payoutRequestId
  );
  return rows[0] || null;
}

async function loadBalance(tx, userIdBig) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT cash_balance_cents, reserved_cash_cents FROM user_balances WHERE user_id = $1 LIMIT 1`,
    userIdBig
  );
  return rows[0] || null;
}

async function audit(tx, payoutRequestId, actorUserId, action, notes, idempotencyKey) {
  await tx.$executeRawUnsafe(
    `INSERT INTO payout_action_events
       (payout_request_id, actor_user_id, action, notes, idempotency_key)
     VALUES ($1::uuid, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    payoutRequestId, actorUserId != null ? BigInt(actorUserId) : null, action, notes, idempotencyKey
  );
}

/**
 * Create a payout request and reserve the amount. Validates min-payout and
 * available cash. Multiple pending requests allowed (Q10). Returns the row.
 */
async function request(prismaClient, { userId, amountCents, payoutMethod, payoutHandle, now = new Date() }) {
  const userIdBig = BigInt(userId);
  assertCents(amountCents, 'amountCents');
  if (amountCents <= 0) throw new PayoutError('invalid_amount');
  if (!VALID_METHODS.has(payoutMethod)) throw new PayoutError('invalid_payout_method');
  if (!payoutHandle) throw new PayoutError('missing_payout_handle');

  return (prismaClient || prisma).$transaction(async (tx) => {
    await lockUser(tx, userIdBig);

    const settings = await BountyDefinitionService.getAdminSettings(tx);
    if (amountCents < settings.minimumPayoutCents) throw new PayoutError('below_minimum_payout');

    const bal = await loadBalance(tx, userIdBig);
    const available = bal ? bal.cash_balance_cents - bal.reserved_cash_cents : 0;
    if (amountCents > available) throw new PayoutError('insufficient_available_cash');

    await tx.$executeRawUnsafe(
      `UPDATE user_balances SET reserved_cash_cents = reserved_cash_cents + $2, updated_at = NOW()
       WHERE user_id = $1`,
      userIdBig, amountCents
    );

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO payout_requests (user_id, amount_cents, payout_method, payout_handle, status)
       VALUES ($1, $2, $3, $4, 'REQUESTED') RETURNING *`,
      userIdBig, amountCents, payoutMethod, payoutHandle
    );
    const pr = rows[0];
    await audit(tx, pr.id, userIdBig, 'REQUESTED', null, `payout_requested:${pr.id}`);
    return pr;
  });
}

/** REQUESTED -> APPROVED. Idempotent if already APPROVED. */
async function approve(prismaClient, { payoutRequestId, adminUserId = null }) {
  return (prismaClient || prisma).$transaction(async (tx) => {
    const pr0 = await loadPayout(tx, payoutRequestId);
    if (!pr0) throw new PayoutError('payout_not_found');
    await lockUserPayout(tx, BigInt(pr0.user_id), pr0.id);

    const pr = await loadPayout(tx, payoutRequestId);
    if (pr.status === 'APPROVED') return { payout: pr, idempotent: true };
    if (pr.status !== 'REQUESTED') throw new PayoutError('cannot_approve_' + pr.status.toLowerCase());

    const upd = await tx.$queryRawUnsafe(
      `UPDATE payout_requests
         SET status = 'APPROVED', reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $1::uuid AND status = 'REQUESTED' RETURNING *`,
      payoutRequestId, adminUserId != null ? BigInt(adminUserId) : null
    );
    await audit(tx, payoutRequestId, adminUserId, 'APPROVED', null, `payout_approved:${payoutRequestId}`);
    return { payout: upd[0], idempotent: false };
  });
}

/**
 * Mark a payout PAID: decrement cash + reserved by the amount. Double Mark-Paid
 * is a no-op (Q9): the `paid_at IS NULL` guard returns zero rows on the second
 * call and the balance is left untouched.
 */
async function markPaid(prismaClient, { payoutRequestId, adminUserId = null }) {
  return (prismaClient || prisma).$transaction(async (tx) => {
    const pr0 = await loadPayout(tx, payoutRequestId);
    if (!pr0) throw new PayoutError('payout_not_found');
    await lockUserPayout(tx, BigInt(pr0.user_id), pr0.id);

    const pr = await loadPayout(tx, payoutRequestId);
    if (pr.paid_at != null || pr.status === 'PAID') {
      return { payout: pr, idempotent: true }; // double-click no-op
    }
    if (pr.status === 'REJECTED') throw new PayoutError('cannot_pay_rejected');

    const idemKey = `payout_paid:${payoutRequestId}`;
    const upd = await tx.$queryRawUnsafe(
      `UPDATE payout_requests
         SET status = 'PAID', paid_at = NOW(),
             reviewed_by = COALESCE(reviewed_by, $2),
             reviewed_at = COALESCE(reviewed_at, NOW()),
             idempotency_key = $3
       WHERE id = $1::uuid AND paid_at IS NULL RETURNING *`,
      payoutRequestId, adminUserId != null ? BigInt(adminUserId) : null, idemKey
    );
    if (upd.length === 0) {
      const again = await loadPayout(tx, payoutRequestId);
      return { payout: again, idempotent: true };
    }

    await tx.$executeRawUnsafe(
      `UPDATE user_balances
         SET cash_balance_cents     = cash_balance_cents - $2,
             reserved_cash_cents    = reserved_cash_cents - $2,
             updated_at = NOW()
       WHERE user_id = $1`,
      BigInt(pr.user_id), pr.amount_cents
    );
    await audit(tx, payoutRequestId, adminUserId, 'PAID', null, idemKey);
    return { payout: upd[0], idempotent: false };
  });
}

/** Reject (from REQUESTED or APPROVED): release the reserve. Cannot reject PAID. */
async function reject(prismaClient, { payoutRequestId, adminUserId = null, notes = null }) {
  return (prismaClient || prisma).$transaction(async (tx) => {
    const pr0 = await loadPayout(tx, payoutRequestId);
    if (!pr0) throw new PayoutError('payout_not_found');
    await lockUserPayout(tx, BigInt(pr0.user_id), pr0.id);

    const pr = await loadPayout(tx, payoutRequestId);
    if (pr.status === 'REJECTED') return { payout: pr, idempotent: true };
    if (pr.status === 'PAID' || pr.paid_at != null) throw new PayoutError('cannot_reject_paid');

    const upd = await tx.$queryRawUnsafe(
      `UPDATE payout_requests
         SET status = 'REJECTED', reviewed_by = $2, reviewed_at = NOW(), admin_notes = $3
       WHERE id = $1::uuid AND status IN ('REQUESTED', 'APPROVED') RETURNING *`,
      payoutRequestId, adminUserId != null ? BigInt(adminUserId) : null, notes
    );
    if (upd.length === 0) {
      const again = await loadPayout(tx, payoutRequestId);
      return { payout: again, idempotent: true };
    }

    await tx.$executeRawUnsafe(
      `UPDATE user_balances SET reserved_cash_cents = reserved_cash_cents - $2, updated_at = NOW()
       WHERE user_id = $1`,
      BigInt(pr.user_id), pr.amount_cents
    );
    await audit(tx, payoutRequestId, adminUserId, 'REJECTED', notes, `payout_rejected:${payoutRequestId}`);
    return { payout: upd[0], idempotent: false };
  });
}

module.exports = {
  request,
  approve,
  markPaid,
  reject,
  PayoutError,
};
