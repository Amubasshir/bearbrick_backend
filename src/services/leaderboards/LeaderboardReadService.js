'use strict';

// LeaderboardReadService — backs GET /api/leaderboards/:key.
//
// Source selection (in order):
//   1. After finalization → 'finalized_snapshot' from leaderboard_period_finalizations
//   2. Inside anti-sniping window (no finalization yet) → 'anti_sniping_snapshot' from
//      leaderboard_visibility_snapshots
//   3. Otherwise → 'live' from leaderboard_state
//
// Tabs:
//   global    → top 100 ranks
//   top100    → top 100 ranks  (alias of global at MVP)
//   around-me → viewer ± around_me_window (config; default 5) within the live slice
//
// `user_row` is always present — the viewer's row for the requested period,
// regardless of tab. May have `eligible=false, rank=null` if the viewer doesn't
// qualify. Used by the UI to show the viewer's standing alongside the chosen
// tab.
//
// `reward_tier_preview` shows the configured reward bundles for the board.
// Pulled from leaderboard_rewards, preferring concrete period_key over '*'.

const prisma = require('../../lib/prisma');
const {
  utcWeekKey, utcWeekStartFromKey, nextUtcWeekKey, LIFETIME_PERIOD_KEY,
} = require('../../lib/utcWeeks');
const {
  getDefinition, loadLeaderboardConfig,
} = require('./LeaderboardDefinitionService');

/**
 * Decide which period_key to read. If caller supplied one, use it (lifetime
 * boards always coerce to LIFETIME). Otherwise default: LIFETIME for lifetime
 * scope, current UTC week for weekly scope.
 */
function resolvePeriodForRead(definition, requestedPeriodKey, nowUtc) {
  if (definition.scope === 'lifetime') return LIFETIME_PERIOD_KEY;
  if (requestedPeriodKey) return requestedPeriodKey;
  return utcWeekKey(nowUtc);
}

/**
 * Determines whether the read should switch to the anti-sniping snapshot.
 * Lifetime boards have no concept of period_end, so they never freeze.
 */
function isAntiSnipingActive(definition, periodKey, nowUtc) {
  if (definition.scope !== 'weekly') return false;
  const windowSec = definition.antiSnipingWindowSeconds;
  if (!windowSec) return false;
  const periodEnd = utcWeekStartFromKey(nextUtcWeekKey(periodKey));
  const windowStart = new Date(periodEnd.getTime() - windowSec * 1000);
  return nowUtc.getTime() >= windowStart.getTime()
      && nowUtc.getTime() <  periodEnd.getTime();
}

/**
 * Fetch top-N rows from live state. Used for tabs global/top100 when source
 * is 'live'.
 */
async function readLiveTop(prismaClient, leaderboardKey, periodKey, limit) {
  return prismaClient.$queryRawUnsafe(
    `SELECT rank, user_id, score::float AS score,
            tie_break_timestamp, eligible
       FROM leaderboard_state
      WHERE leaderboard_key = $1 AND period_key = $2
        AND eligible = TRUE AND rank IS NOT NULL
      ORDER BY rank ASC
      LIMIT ${Math.max(1, Number(limit) || 100)}`,
    leaderboardKey, periodKey
  );
}

/**
 * Read the viewer's row. Returns null when the viewer has never scored on
 * this board+period (no row exists). For ineligible viewers a row may still
 * exist (eligible=false, rank=null).
 */
async function readUserRow(prismaClient, leaderboardKey, periodKey, viewerUserId) {
  if (viewerUserId == null) return null;
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT rank, user_id, score::float AS score,
            tie_break_timestamp, eligible
       FROM leaderboard_state
      WHERE leaderboard_key = $1 AND period_key = $2 AND user_id = $3`,
    leaderboardKey, periodKey, BigInt(viewerUserId)
  );
  return rows[0] || null;
}

/**
 * Around-me slice: viewer ± window from the live ranked rows.
 * - If viewer is ranked: return their rank ± window (clamped at rank 1).
 * - If viewer is unranked but has a row: return the top `2*window+1` ranked rows.
 * - If viewer has no row at all: return the top `2*window+1` ranked rows.
 *
 * Window comes from config (default 5).
 */
async function readAroundMe(prismaClient, leaderboardKey, periodKey, userRow, window) {
  const halfWindow = Math.max(1, Number(window) || 5);
  if (userRow?.rank != null) {
    const lo = Math.max(1, Number(userRow.rank) - halfWindow);
    const hi = Number(userRow.rank) + halfWindow;
    return prismaClient.$queryRawUnsafe(
      `SELECT rank, user_id, score::float AS score,
              tie_break_timestamp, eligible
         FROM leaderboard_state
        WHERE leaderboard_key = $1 AND period_key = $2
          AND eligible = TRUE AND rank IS NOT NULL
          AND rank >= $3 AND rank <= $4
        ORDER BY rank ASC`,
      leaderboardKey, periodKey, lo, hi
    );
  }
  return readLiveTop(prismaClient, leaderboardKey, periodKey, halfWindow * 2 + 1);
}

/**
 * Convert a snapshot JSONB row array (from finalization or visibility snapshot)
 * into the same shape as live rows.
 */
function shapeSnapshotRows(snapshot) {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.map((r) => ({
    rank: r.rank,
    user_id: r.user_id,
    score: typeof r.score === 'number' ? r.score : Number(r.score),
    tie_break_timestamp: r.tie_break_timestamp,
    eligible: true,
  }));
}

/**
 * Load reward_tier_preview for the board+period. Concrete period_key wins
 * over wildcard '*' per the same rule PeriodFinalizationService uses.
 */
async function loadRewardTierPreview(prismaClient, leaderboardKey, periodKey) {
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT placement_tier, period_key, reward_bundle
       FROM leaderboard_rewards
      WHERE leaderboard_key = $1
        AND period_key IN ($2, '*')`,
    leaderboardKey, periodKey
  );
  const byTier = new Map();
  for (const r of rows) {
    const isConcrete = r.period_key === periodKey;
    if (!byTier.has(r.placement_tier) || isConcrete) {
      byTier.set(r.placement_tier, { tier: r.placement_tier, reward_bundle: r.reward_bundle });
    }
  }
  // Order: top_1, top_3, top_10 — friendlier for the UI.
  const order = { top_1: 0, top_3: 1, top_10: 2 };
  return [...byTier.values()].sort((a, b) => (order[a.tier] ?? 99) - (order[b.tier] ?? 99));
}

/**
 * Main read entrypoint. Returns the API shape (BigInts stringified by caller).
 *
 * @param {object} opts
 * @param {string} opts.leaderboardKey
 * @param {string} [opts.periodKey]
 * @param {string} opts.tab               'global' | 'top100' | 'around-me'
 * @param {bigint|number|string} [opts.viewerUserId]
 * @param {Date}   [opts.nowUtc]          for testing; defaults to new Date()
 * @param {*}      [opts.prisma]          for testing
 * @returns {Promise<object>}
 *   { leaderboard_key, period_key, scope, tab, rows, user_row,
 *     reset_at, reward_tier_preview, anti_sniping_active, source }
 *   Throws { status: 404, code: 'not_found' } if leaderboard_key is unknown.
 *   Throws { status: 400, code: 'bad_request' } for malformed inputs.
 */
async function getView({
  leaderboardKey, periodKey, tab,
  viewerUserId, nowUtc, prisma: prismaClient,
}) {
  const client = prismaClient || prisma;
  if (!leaderboardKey) {
    const err = new Error('leaderboardKey is required');
    err.status = 400; err.code = 'bad_request';
    throw err;
  }
  if (!['global', 'top100', 'around-me'].includes(tab)) {
    const err = new Error(`unknown tab "${tab}"`);
    err.status = 400; err.code = 'bad_request';
    throw err;
  }
  if (periodKey && periodKey !== LIFETIME_PERIOD_KEY && !/^\d{4}-W\d{2}$/.test(periodKey)) {
    const err = new Error(`malformed period_key "${periodKey}"`);
    err.status = 400; err.code = 'bad_request';
    throw err;
  }

  const definition = await getDefinition(leaderboardKey, client);
  if (!definition) {
    const err = new Error(`unknown leaderboard "${leaderboardKey}"`);
    err.status = 404; err.code = 'not_found';
    throw err;
  }
  const cfg = await loadLeaderboardConfig(client);
  const now = nowUtc || new Date();
  const resolvedPeriod = resolvePeriodForRead(definition, periodKey, now);

  // Source selection: finalized > anti-sniping > live.
  const [finalRows] = [await client.$queryRawUnsafe(
    `SELECT top_snapshot FROM leaderboard_period_finalizations
      WHERE leaderboard_key = $1 AND period_key = $2`,
    leaderboardKey, resolvedPeriod
  )];
  const finalSnap = finalRows[0]?.top_snapshot || null;

  let antiSnipingActive = false;
  let snapshotRows = null;
  let source = 'live';

  if (finalSnap) {
    source = 'finalized_snapshot';
    snapshotRows = finalSnap;
  } else if (isAntiSnipingActive(definition, resolvedPeriod, now)) {
    antiSnipingActive = true;
    const visRows = await client.$queryRawUnsafe(
      `SELECT top_snapshot FROM leaderboard_visibility_snapshots
        WHERE leaderboard_key = $1 AND period_key = $2`,
      leaderboardKey, resolvedPeriod
    );
    if (visRows[0]?.top_snapshot) {
      source = 'anti_sniping_snapshot';
      snapshotRows = visRows[0].top_snapshot;
    }
    // Edge case: window opened but worker hasn't written the snapshot yet —
    // serve live rows but still report anti_sniping_active=true so the UI can
    // hint "ranks freezing soon".
  }

  const userRow = await readUserRow(client, leaderboardKey, resolvedPeriod, viewerUserId);

  let rows;
  if (snapshotRows) {
    rows = shapeSnapshotRows(snapshotRows);
    if (tab === 'around-me' && userRow?.rank != null) {
      const window = cfg.aroundMeWindow;
      const lo = Math.max(1, Number(userRow.rank) - window);
      const hi = Number(userRow.rank) + window;
      rows = rows.filter((r) => r.rank >= lo && r.rank <= hi);
    }
  } else if (tab === 'around-me') {
    rows = await readAroundMe(client, leaderboardKey, resolvedPeriod, userRow, cfg.aroundMeWindow);
  } else {
    rows = await readLiveTop(client, leaderboardKey, resolvedPeriod, 100);
  }

  const rewardTierPreview = definition.rewardEnabled
    ? await loadRewardTierPreview(client, leaderboardKey, resolvedPeriod)
    : [];

  const resetAt = definition.scope === 'weekly'
    ? utcWeekStartFromKey(nextUtcWeekKey(resolvedPeriod))
    : null;

  return {
    leaderboard_key: leaderboardKey,
    period_key: resolvedPeriod,
    scope: definition.scope,
    tab,
    rows,
    user_row: userRow,
    reset_at: resetAt,
    reward_tier_preview: rewardTierPreview,
    anti_sniping_active: antiSnipingActive,
    source,
  };
}

module.exports = {
  getView,
  // exposed for testing
  resolvePeriodForRead,
  isAntiSnipingActive,
  shapeSnapshotRows,
  loadRewardTierPreview,
};
