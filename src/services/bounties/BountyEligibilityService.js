'use strict';

// BountyEligibilityService — defensive account-state / email-verification gate
// for bounty submission. Mirrors the M3c/M3d graceful-pass-through pattern: if a
// gating column is somehow absent or null, default to permissive rather than
// hard-failing, so the milestone never blocks on a not-yet-populated column.
//
// account_state and email_verified_at both exist on "User" as of M4 migration 3
// (account_state) and earlier (email_verified_at), so the normal path reads real
// values; the degraded path is purely defensive.

const prisma = require('../../lib/prisma');

const BLOCKING_STATES = new Set([
  'read_only',
  'suspended_temporary',
  'banned_permanent',
]);

/**
 * Pure decision over a user row. Accepts snake_case (raw SQL) or camelCase
 * (Prisma) shapes. A null/undefined account_state is treated as 'active'.
 * Returns { eligible, reason }.
 */
function evaluate(userRow, { requiresEmailVerification = false } = {}) {
  if (!userRow) return { eligible: false, reason: 'user_not_found' };

  const accountState =
    userRow.account_state != null ? userRow.account_state
      : userRow.accountState != null ? userRow.accountState
        : 'active';

  if (BLOCKING_STATES.has(accountState)) {
    return { eligible: false, reason: `account_${accountState}` };
  }

  if (requiresEmailVerification) {
    const verified =
      userRow.email_verified_at != null ? userRow.email_verified_at
        : userRow.emailVerifiedAt != null ? userRow.emailVerifiedAt
          : null;
    if (!verified) return { eligible: false, reason: 'email_not_verified' };
  }

  return { eligible: true, reason: null };
}

/**
 * Read the user's gating columns and evaluate. Graceful pass-through if the
 * columns are missing (returns eligible with degraded: true).
 */
async function checkUser(client, userId, opts = {}) {
  let rows;
  try {
    rows = await (client || prisma).$queryRawUnsafe(
      `SELECT id, account_state, email_verified_at FROM "User" WHERE id = $1 LIMIT 1`,
      BigInt(userId)
    );
  } catch (e) {
    // Columns absent (should not happen post-M4) -> permissive, flagged.
    return { eligible: true, reason: null, degraded: true };
  }
  return evaluate(rows[0], opts);
}

module.exports = {
  evaluate,
  checkUser,
  BLOCKING_STATES,
};
