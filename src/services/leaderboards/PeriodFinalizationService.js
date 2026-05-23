'use strict';

// PeriodFinalizationService — closes one weekly leaderboard period:
//   1. Acquire per-period advisory lock (same key the leaderboard-worker uses,
//      so we serialize against in-flight reranks).
//   2. Double-check no leaderboard_period_finalizations row exists.
//   3. Run a final rerank to make sure the snapshot reflects the true closing
//      state.
//   4. Materialize the top-N snapshot (config: leaderboard.top_snapshot_size).
//   5. INSERT leaderboard_period_finalizations with literal idempotency key
//        'lb_finalization:{leaderboard_key}:{period_key}'
//   6. For each placement tier with a matching leaderboard_rewards row
//      (period_key = period or period_key = '*'), hand the matching state row
//      to RewardIssuanceService.issue.
//
// Lifetime boards are never finalized — their period_end is never reached.
// findDuePeriods only returns rotating boards whose UTC period_end has passed.
//
// Anti-sniping visibility snapshots are NOT written here. That's the worker's
// job — it observes the window-start condition and writes the
// leaderboard_visibility_snapshots row. Finalization writes a separate, frozen
// post-period snapshot.

const prisma = require('../../lib/prisma');
const {
  utcWeekStartFromKey, nextUtcWeekKey, utcWeekKey,
} = require('../../lib/utcWeeks');
const {
  acquirePeriodLock, rerank,
} = require('./LeaderboardRankingService');
const { listActive, loadLeaderboardConfig } =
  require('./LeaderboardDefinitionService');
const RewardIssuanceService = require('./RewardIssuanceService');

const PLACEMENT_TIERS = [
  { tier: 'top_1',  maxRank: 1 },
  { tier: 'top_3',  maxRank: 3 },
  { tier: 'top_10', maxRank: 10 },
];

/**
 * Build the literal finalization idempotency key. Asserted in tests.
 */
function buildIdempotencyKey({ leaderboardKey, periodKey }) {
  return `lb_finalization:${leaderboardKey}:${periodKey}`;
}

/**
 * Find rotating (weekly) periods whose UTC end has passed AND for which no
 * leaderboard_period_finalizations row exists.
 *
 * Strategy: for each active weekly definition, derive the previous UTC week
 * key (since the "current" week hasn't ended yet) — and any older periods
 * surfaced by leaderboard_state for that board that don't have a finalization
 * row. The state-driven sweep handles the case where the worker has been off
 * for multiple weeks.
 *
 * Returns array of { leaderboardKey, periodKey, periodEnd } sorted ASC by
 * periodEnd so the caller can finalize oldest-first.
 */
async function findDuePeriods(txOrPrisma = prisma, nowUtc = new Date()) {
  const defs = await listActive(txOrPrisma);
  const weeklyDefs = defs.filter((d) => d.scope === 'weekly');
  if (weeklyDefs.length === 0) return [];

  const currentWeek = utcWeekKey(nowUtc);
  const out = [];

  for (const def of weeklyDefs) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await txOrPrisma.$queryRawUnsafe(
      `SELECT DISTINCT ls.period_key
         FROM leaderboard_state ls
         LEFT JOIN leaderboard_period_finalizations lpf
           ON lpf.leaderboard_key = ls.leaderboard_key
          AND lpf.period_key      = ls.period_key
        WHERE ls.leaderboard_key = $1
          AND ls.period_key     <> $2
          AND lpf.id IS NULL`,
      def.leaderboardKey, currentWeek
    );
    for (const r of rows) {
      const pkEnd = utcWeekStartFromKey(nextUtcWeekKey(r.period_key));
      if (pkEnd.getTime() > nowUtc.getTime()) continue; // future period, skip
      out.push({
        leaderboardKey: def.leaderboardKey,
        periodKey: r.period_key,
        periodEnd: pkEnd,
        definition: def,
      });
    }
  }

  out.sort((a, b) => a.periodEnd.getTime() - b.periodEnd.getTime());
  return out;
}

/**
 * Read the top-N rows of one (leaderboard_key, period_key) slice. Used both
 * for the visibility snapshot and the finalization snapshot.
 */
async function readTopSnapshot(tx, leaderboardKey, periodKey, n) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT rank, user_id, score::float AS score,
            tie_break_timestamp, tie_break_event_id
       FROM leaderboard_state
      WHERE leaderboard_key = $1 AND period_key = $2
        AND eligible = TRUE AND rank IS NOT NULL
      ORDER BY rank ASC
      LIMIT ${Math.max(1, Number(n) || 10)}`,
    leaderboardKey, periodKey
  );
  return rows.map((r) => ({
    rank: r.rank,
    user_id: r.user_id != null ? String(r.user_id) : null,
    score: r.score,
    tie_break_timestamp: r.tie_break_timestamp,
    tie_break_event_id: r.tie_break_event_id != null
      ? String(r.tie_break_event_id) : null,
  }));
}

/**
 * Look up reward bundles configured for this (leaderboard, period). A concrete
 * period_key row takes precedence over the wildcard '*' for the same tier.
 * Returns Map<placement_tier, reward_bundle>.
 */
async function loadRewardBundles(tx, leaderboardKey, periodKey) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT placement_tier, period_key, reward_bundle
       FROM leaderboard_rewards
      WHERE leaderboard_key = $1
        AND period_key IN ($2, '*')`,
    leaderboardKey, periodKey
  );
  // Concrete period_key wins over '*'. Sort so concrete entries overwrite.
  const byTier = new Map();
  for (const r of rows) {
    const isConcrete = r.period_key === periodKey;
    if (!byTier.has(r.placement_tier) || isConcrete) {
      byTier.set(r.placement_tier, {
        bundle: r.reward_bundle,
        isConcrete,
      });
    }
  }
  return new Map([...byTier.entries()].map(([k, v]) => [k, v.bundle]));
}

/**
 * Read winners by placement tier from the live leaderboard_state for the given
 * (lb_key, period_key). Returns Map<placement_tier, Array<userIdString>>.
 * Tier ranges: top_1 = rank 1; top_3 = ranks 2–3; top_10 = ranks 4–10.
 */
async function identifyWinners(tx, leaderboardKey, periodKey) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT user_id, rank
       FROM leaderboard_state
      WHERE leaderboard_key = $1 AND period_key = $2
        AND eligible = TRUE AND rank IS NOT NULL AND rank <= 10
      ORDER BY rank ASC`,
    leaderboardKey, periodKey
  );
  const byTier = { top_1: [], top_3: [], top_10: [] };
  for (const r of rows) {
    if (r.rank === 1)                       byTier.top_1.push(String(r.user_id));
    else if (r.rank >= 2 && r.rank <= 3)    byTier.top_3.push(String(r.user_id));
    else if (r.rank >= 4 && r.rank <= 10)   byTier.top_10.push(String(r.user_id));
  }
  return byTier;
}

/**
 * Finalize one period. See module header for the full step list.
 *
 * Returns:
 *   { finalized: boolean, alreadyFinalized?: boolean, totalEligible, topSnapshotSize,
 *     rewardsIssued: number, rewardsSkipped: number }
 *
 * Reward issuance is intentionally OUTSIDE the finalization transaction. The
 * finalization row is the contract that the period is closed; rewards are
 * idempotent and retry on subsequent ticks if any individual issuance fails.
 */
async function finalizePeriod(prismaClient, leaderboardKey, periodKey) {
  const cfg = await loadLeaderboardConfig(prismaClient);
  const topN = cfg.topSnapshotSize;

  // Outer transaction: lock, double-check, rerank, snapshot, INSERT finalization.
  const finalizationResult = await prismaClient.$transaction(async (tx) => {
    await acquirePeriodLock(tx, leaderboardKey, periodKey);

    const existing = await tx.$queryRawUnsafe(
      `SELECT id FROM leaderboard_period_finalizations
        WHERE leaderboard_key = $1 AND period_key = $2`,
      leaderboardKey, periodKey
    );
    if (existing.length > 0) {
      return { alreadyFinalized: true };
    }

    // Final rerank so the snapshot reflects truth as-of close.
    await rerank(tx, leaderboardKey, periodKey);

    const topSnapshot = await readTopSnapshot(tx, leaderboardKey, periodKey, topN);
    const [eligibleCountRow] = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM leaderboard_state
        WHERE leaderboard_key = $1 AND period_key = $2 AND eligible = TRUE`,
      leaderboardKey, periodKey
    );
    const totalEligible = Number(eligibleCountRow?.n || 0);

    const idempotencyKey = buildIdempotencyKey({ leaderboardKey, periodKey });
    await tx.$executeRawUnsafe(
      `INSERT INTO leaderboard_period_finalizations
         (leaderboard_key, period_key, total_eligible_users, top_snapshot, idempotency_key)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      leaderboardKey, periodKey, totalEligible,
      JSON.stringify(topSnapshot), idempotencyKey
    );

    // Mark the matching leaderboard_rewards rows as processed (for the concrete
    // period_key). Wildcard rows stay unprocessed — they apply to future periods.
    await tx.$executeRawUnsafe(
      `UPDATE leaderboard_rewards SET processed_at = NOW()
        WHERE leaderboard_key = $1 AND period_key = $2 AND processed_at IS NULL`,
      leaderboardKey, periodKey
    );

    return {
      alreadyFinalized: false,
      totalEligible,
      topSnapshotSize: topSnapshot.length,
    };
  });

  if (finalizationResult.alreadyFinalized) {
    return {
      finalized: false,
      alreadyFinalized: true,
      totalEligible: 0,
      topSnapshotSize: 0,
      rewardsIssued: 0,
      rewardsSkipped: 0,
    };
  }

  // Reward issuance phase — outside the finalization transaction so a slow
  // resolveBundleEntry doesn't hold the period lock.
  const bundlesByTier = await loadRewardBundles(prismaClient, leaderboardKey, periodKey);
  const winners = await identifyWinners(prismaClient, leaderboardKey, periodKey);

  let issued = 0;
  let skipped = 0;
  for (const { tier } of PLACEMENT_TIERS) {
    const bundle = bundlesByTier.get(tier);
    if (!bundle) continue; // no reward configured for this tier
    for (const userId of winners[tier]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await RewardIssuanceService.issue(prismaClient, {
        userId,
        leaderboardKey,
        periodKey,
        placementTier: tier,
        rewardBundle: bundle,
      });
      if (result.issued) issued += 1; else skipped += 1;
    }
  }

  return {
    finalized: true,
    alreadyFinalized: false,
    totalEligible: finalizationResult.totalEligible,
    topSnapshotSize: finalizationResult.topSnapshotSize,
    rewardsIssued: issued,
    rewardsSkipped: skipped,
  };
}

/**
 * Anti-sniping helper: write the visibility snapshot under the period advisory
 * lock if we're inside the window and the snapshot row doesn't exist yet.
 * Called by the worker; safe to retry (UNIQUE(lb_key, period_key) makes it a
 * no-op after the first successful write).
 *
 * Returns { written: boolean, reason?: 'no_window' | 'before_window' | 'after_period' | 'already_snapshotted' }
 */
async function writeAntiSnipingSnapshot(prismaClient, leaderboardKey, periodKey, nowUtc = new Date()) {
  const cfg = await loadLeaderboardConfig(prismaClient);
  const topN = cfg.topSnapshotSize;
  const defs = await listActive(prismaClient);
  const def = defs.find((d) => d.leaderboardKey === leaderboardKey);
  if (!def || def.scope !== 'weekly') return { written: false, reason: 'no_window' };
  const windowSec = def.antiSnipingWindowSeconds;
  if (!windowSec) return { written: false, reason: 'no_window' };

  const periodEnd = utcWeekStartFromKey(nextUtcWeekKey(periodKey));
  const windowStart = new Date(periodEnd.getTime() - windowSec * 1000);
  if (nowUtc.getTime() < windowStart.getTime()) {
    return { written: false, reason: 'before_window' };
  }
  if (nowUtc.getTime() >= periodEnd.getTime()) {
    return { written: false, reason: 'after_period' };
  }

  return prismaClient.$transaction(async (tx) => {
    await acquirePeriodLock(tx, leaderboardKey, periodKey);

    const existing = await tx.$queryRawUnsafe(
      `SELECT id FROM leaderboard_visibility_snapshots
        WHERE leaderboard_key = $1 AND period_key = $2`,
      leaderboardKey, periodKey
    );
    if (existing.length > 0) {
      return { written: false, reason: 'already_snapshotted' };
    }

    const topSnapshot = await readTopSnapshot(tx, leaderboardKey, periodKey, topN);
    await tx.$executeRawUnsafe(
      `INSERT INTO leaderboard_visibility_snapshots
         (leaderboard_key, period_key, top_snapshot)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (leaderboard_key, period_key) DO NOTHING`,
      leaderboardKey, periodKey, JSON.stringify(topSnapshot)
    );
    return { written: true, topSnapshotSize: topSnapshot.length };
  });
}

module.exports = {
  findDuePeriods,
  finalizePeriod,
  writeAntiSnipingSnapshot,
  buildIdempotencyKey,
  // exposed for testing
  readTopSnapshot,
  loadRewardBundles,
  identifyWinners,
  PLACEMENT_TIERS,
};
