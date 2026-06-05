'use strict';

// monthly-budget-reset-worker — resets the cash budget on the 1st of each month
// at 00:00 UTC (spec §17.8 / §20). Sets monthly_cash_spent_cents back to 0 and
// re-enables cash rewards. Idempotent via the monthly_budget_last_reset_period
// marker (YYYY-MM): if the marker already equals the current UTC month, the tick
// is a no-op, so the worker is safe to run on any day / any number of times — it
// resets at most once per calendar month and self-heals if it missed the 1st.
//
// A single global advisory lock serializes concurrent worker instances; the
// marker is the durable idempotency guard.

const prisma = require('../lib/prisma');

function utcMonthKey(nowUtc) {
  const y = nowUtc.getUTCFullYear();
  const m = String(nowUtc.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Run one tick. Returns { reset, period }. `reset` is false when the current
 * UTC month has already been reset (marker match).
 */
async function processOneTick(prismaClient = prisma, options = {}) {
  const nowUtc = options.nowUtc ?? new Date();
  const period = utcMonthKey(nowUtc);

  return prismaClient.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext('monthly_budget_reset')::bigint)`
    );

    const markerRows = await tx.$queryRawUnsafe(
      `SELECT value FROM admin_settings WHERE key = 'monthly_budget_last_reset_period'`
    );
    const marker = markerRows[0] ? markerRows[0].value : null;
    if (marker === period) {
      return { reset: false, period };
    }

    await tx.$executeRawUnsafe(
      `UPDATE admin_settings SET value = '0', updated_at = NOW() WHERE key = 'monthly_cash_spent_cents'`
    );
    await tx.$executeRawUnsafe(
      `UPDATE admin_settings SET value = 'true', updated_at = NOW() WHERE key = 'cash_rewards_enabled'`
    );
    await tx.$executeRawUnsafe(
      `UPDATE admin_settings SET value = $1, updated_at = NOW() WHERE key = 'monthly_budget_last_reset_period'`,
      period
    );
    return { reset: true, period };
  });
}

async function runWorkerLoop() {
  console.log('[monthly-budget-reset-worker] starting');
  const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly; the marker gates the work
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await processOneTick(prisma);
      if (r.reset) console.log(`[monthly-budget-reset-worker] reset budget for ${r.period}`);
    } catch (err) {
      console.error('[monthly-budget-reset-worker] tick error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { processOneTick, utcMonthKey };

if (require.main === module) {
  runWorkerLoop().catch((err) => {
    console.error('[monthly-budget-reset-worker] fatal:', err);
    process.exit(1);
  });
}
