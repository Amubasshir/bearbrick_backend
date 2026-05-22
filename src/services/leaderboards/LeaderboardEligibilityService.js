'use strict';

// Evaluates eligibility_rule jsonb against a user's current state. Returns
//   { eligible: boolean, reasons: string[] }
//
// `reasons` lists every rule the user fails. Empty array → user passes.
// `reasons` is for diagnostics / logging only — never exposed to the API.
//
// Supported rule keys (extend by adding a case to applyRule):
//   min_level                   — user_progress_state.current_level >= N
//   min_lifetime_xp             — user_progress_state.total_xp_confirmed >= N
//   min_weekly_actions          — count of confirmed xp_events in period >= N
//   min_dex_completion_pct      — completion percent >= N (mirrors M2 source)
//   min_approved_contributions  — count of approved contributions >= N (STUB → always 0)
//   exclude_banned              — User.is_banned IS NOT TRUE (graceful absence)
//
// Graceful column absence: rules referencing columns that don't exist yet
// (notably users.is_banned) pass silently — mirrors the M3c lifecycle-state
// graceful-substitution pattern. Column existence is cached at first lookup.

const prisma = require('../../lib/prisma');
const { utcWeekStartFromKey, nextUtcWeekKey } = require('../../lib/utcWeeks');

let _isBannedColumnExistsCache; // Promise<boolean> | undefined

async function isBannedColumnExists(prismaClient = prisma) {
  if (_isBannedColumnExistsCache !== undefined) return _isBannedColumnExistsCache;
  _isBannedColumnExistsCache = (async () => {
    const rows = await prismaClient.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'User' AND column_name = 'is_banned'
        LIMIT 1`
    );
    return rows.length > 0;
  })();
  return _isBannedColumnExistsCache;
}

// Resets the cache. Tests may call this between fixtures that mutate the
// schema; production never calls it.
function _resetColumnCache() {
  _isBannedColumnExistsCache = undefined;
}

/**
 * Returns the user's current state needed by all eligibility rules in one
 * trip. Cheap (1 row from user_progress_state) — far cheaper than per-rule
 * round trips.
 */
async function loadUserSnapshot(userId, prismaClient = prisma) {
  const userIdBig = BigInt(userId);
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT current_level, total_xp_confirmed
       FROM user_progress_state
      WHERE user_id = $1`,
    userIdBig
  );
  return {
    userId: userIdBig,
    currentLevel: rows[0]?.current_level != null ? Number(rows[0].current_level) : 0,
    totalXpConfirmed: rows[0]?.total_xp_confirmed != null
      ? Number(rows[0].total_xp_confirmed)
      : 0,
  };
}

async function ruleMinLevel(snap, threshold) {
  return snap.currentLevel >= Number(threshold);
}

async function ruleMinLifetimeXp(snap, threshold) {
  return snap.totalXpConfirmed >= Number(threshold);
}

async function ruleMinWeeklyActions(snap, threshold, { definition, periodKey, txOrPrisma }) {
  // Weekly action count is only meaningful for weekly/rotating boards.
  // On lifetime boards, the rule passes (no period to bound against).
  if (definition.scope === 'lifetime') return true;
  const start = utcWeekStartFromKey(periodKey);
  const end = utcWeekStartFromKey(nextUtcWeekKey(periodKey));
  const row = await txOrPrisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n
       FROM xp_events
      WHERE user_id      = $1
        AND xp_confirmed = TRUE
        AND "createdAt" >= $2
        AND "createdAt" <  $3`,
    snap.userId, start, end
  );
  return Number(row[0]?.n || 0) >= Number(threshold);
}

async function ruleMinDexCompletionPct(snap, threshold, { txOrPrisma }) {
  const [denomRow] = await txOrPrisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM bricks WHERE status = 'PUBLISHED'`
  );
  const denom = Number(denomRow?.n || 0);
  if (denom === 0) return false; // edge: no published bricks → impossible to satisfy
  const [numRow] = await txOrPrisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM user_brick_progress
      WHERE user_id = $1 AND stage = 3`,
    snap.userId
  );
  const pct = (Number(numRow?.n || 0) / denom) * 100;
  return pct >= Number(threshold);
}

async function ruleMinApprovedContributions(_snap, _threshold, _ctx) {
  // TODO(contribution-milestone): replace with real query over the approved
  // contribution ledger. Until then, the count is 0 → any threshold >= 1
  // fails, gating the lifetime_contribution_weighted board per resolved
  // decision Q6.
  return false;
}

async function ruleExcludeBanned(snap, _value, { txOrPrisma }) {
  const exists = await isBannedColumnExists(txOrPrisma);
  if (!exists) return true; // graceful absence
  const row = await txOrPrisma.$queryRawUnsafe(
    `SELECT is_banned FROM "User" WHERE id = $1`,
    snap.userId
  );
  // Treat NULL / FALSE as not-banned. Treat missing row as not-banned (the
  // ranking worker shouldn't see those, but be defensive).
  return !(row[0]?.is_banned === true);
}

const RULE_HANDLERS = {
  min_level:                   ruleMinLevel,
  min_lifetime_xp:             ruleMinLifetimeXp,
  min_weekly_actions:          ruleMinWeeklyActions,
  min_dex_completion_pct:      ruleMinDexCompletionPct,
  min_approved_contributions:  ruleMinApprovedContributions,
  exclude_banned:              ruleExcludeBanned,
};

/**
 * Evaluate `definition.eligibilityRule` against the user's current state.
 * Returns { eligible, reasons }.
 *
 * The rule object is treated as an AND of all rules. Unknown rule keys are
 * silently ignored with a warning — allowing forward-compatible config.
 */
async function evaluate(definition, userId, periodKey, txOrPrisma = prisma) {
  if (!definition) throw new Error('evaluate: definition is required');
  const rules = definition.eligibilityRule || {};
  const snap = await loadUserSnapshot(userId, txOrPrisma);
  const reasons = [];
  const ctx = { definition, periodKey, txOrPrisma };

  for (const [key, threshold] of Object.entries(rules)) {
    const handler = RULE_HANDLERS[key];
    if (!handler) continue; // forward-compatible: silently ignore unknown keys
    // eslint-disable-next-line no-await-in-loop
    const ok = await handler(snap, threshold, ctx);
    if (!ok) reasons.push(`${key}_fail`);
  }

  return { eligible: reasons.length === 0, reasons };
}

module.exports = {
  evaluate,
  loadUserSnapshot,
  // exposed for testing only
  isBannedColumnExists,
  _resetColumnCache,
};
