'use strict';

// period-finalization-worker — runs every 60s and does two things:
//
//   1. Writes anti-sniping visibility snapshots for any active weekly period
//      that has entered its anti-sniping window (period_end - window_sec ≤
//      nowUtc < period_end) and has no visibility snapshot row yet.
//
//   2. Finalizes any past period whose UTC end has passed and which lacks a
//      leaderboard_period_finalizations row. Reward issuance fires inside
//      finalizePeriod() under its own per-user advisory locks.
//
// Both operations are idempotent at the row level — the worker can be
// restarted, run twice, or lag for hours; the unique constraints on
// leaderboard_visibility_snapshots / leaderboard_period_finalizations /
// leaderboard_reward_events catch any duplicate work.
//
// Per the plan: finalization is the wide lock; reward issuance failures don't
// roll back the finalization row, they retry on subsequent ticks via the
// per-reward idempotency key.

const prisma = require('../lib/prisma');
const { listActive } =
  require('../services/leaderboards/LeaderboardDefinitionService');
const {
  findDuePeriods, finalizePeriod, writeAntiSnipingSnapshot,
} = require('../services/leaderboards/PeriodFinalizationService');
const {
  utcWeekKey, utcWeekStartFromKey, nextUtcWeekKey,
} = require('../lib/utcWeeks');

/**
 * For each active weekly board, check whether the CURRENT period is inside
 * its anti-sniping window and, if so, ask the service to write the snapshot
 * (no-op if one already exists). Returns the list of (lb_key, period_key,
 * written) tuples for logging.
 */
async function processAntiSnipingSnapshots(prismaClient, nowUtc) {
  const defs = await listActive(prismaClient);
  const results = [];
  for (const def of defs) {
    if (def.scope !== 'weekly') continue;
    const windowSec = def.antiSnipingWindowSeconds;
    if (!windowSec) continue;
    const currentPeriod = utcWeekKey(nowUtc);
    const periodEnd = utcWeekStartFromKey(nextUtcWeekKey(currentPeriod));
    const windowStart = new Date(periodEnd.getTime() - windowSec * 1000);
    if (nowUtc.getTime() < windowStart.getTime()) continue;
    if (nowUtc.getTime() >= periodEnd.getTime()) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await writeAntiSnipingSnapshot(
      prismaClient, def.leaderboardKey, currentPeriod, nowUtc
    );
    results.push({
      leaderboardKey: def.leaderboardKey, periodKey: currentPeriod, ...r,
    });
  }
  return results;
}

/**
 * Run one tick: process anti-sniping snapshots, then finalize any due periods.
 * Each due period is handled independently so one failure doesn't block others.
 */
async function processOneTick(prismaClient = prisma, options = {}) {
  const nowUtc = options.nowUtc ?? new Date();

  const snapshots = await processAntiSnipingSnapshots(prismaClient, nowUtc);

  const due = await findDuePeriods(prismaClient, nowUtc);
  const finalizations = [];
  for (const p of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await finalizePeriod(
        prismaClient, p.leaderboardKey, p.periodKey
      );
      finalizations.push({
        leaderboardKey: p.leaderboardKey, periodKey: p.periodKey, ...result,
      });
    } catch (err) {
      // Log and keep going; next tick retries via the unique constraint.
      console.error(
        `[period-finalization-worker] finalize ${p.leaderboardKey}/${p.periodKey} failed:`,
        err.message
      );
    }
  }

  return { snapshots, finalizations };
}

async function runWorkerLoop() {
  console.log('[period-finalization-worker] starting');
  const POLL_INTERVAL_MS = 60_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await processOneTick(prisma);
    } catch (err) {
      console.error('[period-finalization-worker] tick error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = {
  processOneTick,
  processAntiSnipingSnapshots,
};

if (require.main === module) {
  runWorkerLoop().catch((err) => {
    console.error('[period-finalization-worker] fatal:', err);
    process.exit(1);
  });
}
