'use strict';

// leaderboard-worker — polls xp_events and user_brick_progress, recomputes
// scores from canonical sources, upserts into leaderboard_state, and reranks
// each affected (leaderboard_key, period_key) slice under a per-period
// advisory lock.
//
// Key invariants (asserted by tests):
//   • Period assignment uses xp_events.created_at (UTC) — per Spec_ANSWERS Q9.
//   • Tie-break uses xp_events.created_at + id — per Spec_ANSWERS Q5.
//   • Scores are RECOMPUTED FROM TRUTH each tick (no running counters).
//   • Eligibility filter is applied BEFORE ranking.
//   • The worker NEVER writes an xp_event. Asserted by xp_events count diff.
//   • Per-period advisory lock; no user-level locks (those are M3a/M3b/M3c's).
//
// Cursors (rows in worker_cursors):
//   • 'leaderboard-worker:xp_events'           → last_processed_id = xp_events.id
//   • 'leaderboard-worker:user_brick_progress' → last_processed_id = ms-since-epoch
//
// The user_brick_progress cursor stores updated_at as ms-since-epoch because
// that table's PK is composite (user_id + brick_id) — no monotonic id to use.
// To survive same-ms updates we advance cursor to max-1ms; the next tick will
// reprocess that 1ms window. Safe because score recompute is idempotent.

const prisma = require('../lib/prisma');
const { listActive, resolvePeriodKey } =
  require('../services/leaderboards/LeaderboardDefinitionService');
const { computeScore } =
  require('../services/leaderboards/LeaderboardScoreService');
const { evaluate: evaluateEligibility } =
  require('../services/leaderboards/LeaderboardEligibilityService');
const {
  acquirePeriodLock, rerank, upsertState,
} = require('../services/leaderboards/LeaderboardRankingService');
const { utcWeekKey } = require('../lib/utcWeeks');

const XP_CURSOR = 'leaderboard-worker:xp_events';
const DEX_CURSOR = 'leaderboard-worker:user_brick_progress';

// ── Cursor primitives ────────────────────────────────────────────────────────

async function getCursor(prismaClient, name) {
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT last_processed_id FROM worker_cursors WHERE worker_name = $1`,
    name
  );
  if (rows.length === 0) {
    await prismaClient.$queryRawUnsafe(
      `INSERT INTO worker_cursors (worker_name, last_processed_id, "updatedAt")
       VALUES ($1, 0, NOW()) ON CONFLICT (worker_name) DO NOTHING`,
      name
    );
    return BigInt(0);
  }
  return BigInt(rows[0].last_processed_id);
}

async function setCursor(prismaClient, name, value) {
  await prismaClient.$queryRawUnsafe(
    `UPDATE worker_cursors SET last_processed_id = $2, "updatedAt" = NOW()
      WHERE worker_name = $1`,
    name, BigInt(value)
  );
}

/**
 * Reset both cursors to zero. Used by tests; never called in production.
 */
async function resetCursors(prismaClient = prisma) {
  await prismaClient.$queryRawUnsafe(
    `UPDATE worker_cursors SET last_processed_id = 0 WHERE worker_name IN ($1, $2)`,
    XP_CURSOR, DEX_CURSOR
  );
}

// ── Definition partitioning ─────────────────────────────────────────────────

function partitionDefinitions(defs) {
  const collectorXp = defs.filter((d) => d.metricType === 'collector_xp');
  const dexCompletion = defs.filter((d) => d.metricType === 'dex_completion_percent');
  // approved_contribution_weight boards exist in the catalogue but have no
  // event source today — they get no upserts until the contribution milestone.
  return { collectorXp, dexCompletion };
}

// ── XP event ingestion ──────────────────────────────────────────────────────

/**
 * Pulls up to `limit` new confirmed xp_events. Returns:
 *   { affected: Map<sliceKey, { definition, periodKey, userIds: Set<bigint> }>,
 *     maxId: bigint|null }
 *
 * sliceKey = `${leaderboardKey}|${periodKey}` — used to deduplicate work
 * across users hitting the same slice from multiple events.
 */
async function gatherXpEventAffects(prismaClient, collectorXpDefs, limit) {
  const cursor = await getCursor(prismaClient, XP_CURSOR);
  const events = await prismaClient.$queryRawUnsafe(
    `SELECT id, user_id, "createdAt" AS created_at
       FROM xp_events
      WHERE id > $1 AND xp_confirmed = TRUE
      ORDER BY "createdAt" ASC, id ASC
      LIMIT ${limit}`,
    cursor
  );
  if (events.length === 0) return { affected: new Map(), maxId: null };

  const affected = new Map();
  let maxId = cursor;

  for (const ev of events) {
    if (BigInt(ev.id) > maxId) maxId = BigInt(ev.id);
    const userIdBig = BigInt(ev.user_id);
    const eventCreatedAt = ev.created_at instanceof Date
      ? ev.created_at
      : new Date(ev.created_at);

    for (const def of collectorXpDefs) {
      let periodKey;
      if (def.scope === 'lifetime') {
        periodKey = 'LIFETIME';
      } else if (def.scope === 'weekly') {
        // Q9: period key derived from the EVENT's UTC time, not now().
        periodKey = utcWeekKey(eventCreatedAt);
      } else {
        continue; // monthly/etc. not supported at MVP
      }
      const sliceKey = `${def.leaderboardKey}|${periodKey}`;
      let slice = affected.get(sliceKey);
      if (!slice) {
        slice = { definition: def, periodKey, userIds: new Set() };
        affected.set(sliceKey, slice);
      }
      slice.userIds.add(userIdBig);
    }
  }

  return { affected, maxId };
}

// ── Dex progression ingestion ───────────────────────────────────────────────

/**
 * Pulls up to `limit` new user_brick_progress rows since the dex cursor.
 * Returns same shape as gatherXpEventAffects, plus the max updated_at in ms.
 *
 * We only care about stage=3 (Dex complete) rows for the percent calculation.
 * Lower stages don't move the dex_completion score, so we skip them.
 */
async function gatherBrickProgressAffects(prismaClient, dexDefs, limit) {
  if (dexDefs.length === 0) {
    return { affected: new Map(), maxUpdatedAtMs: null };
  }
  const cursorMs = await getCursor(prismaClient, DEX_CURSOR);
  const cursorTs = new Date(Number(cursorMs));
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT user_id, updated_at
       FROM user_brick_progress
      WHERE updated_at > $1
        AND stage = 3
      ORDER BY updated_at ASC
      LIMIT ${limit}`,
    cursorTs
  );
  if (rows.length === 0) return { affected: new Map(), maxUpdatedAtMs: null };

  const affected = new Map();
  let maxMs = Number(cursorMs);

  for (const r of rows) {
    const ts = r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at);
    if (ts.getTime() > maxMs) maxMs = ts.getTime();
    const userIdBig = BigInt(r.user_id);

    for (const def of dexDefs) {
      // Dex completion is lifetime-only at MVP.
      if (def.scope !== 'lifetime') continue;
      const sliceKey = `${def.leaderboardKey}|LIFETIME`;
      let slice = affected.get(sliceKey);
      if (!slice) {
        slice = { definition: def, periodKey: 'LIFETIME', userIds: new Set() };
        affected.set(sliceKey, slice);
      }
      slice.userIds.add(userIdBig);
    }
  }

  return { affected, maxUpdatedAtMs: maxMs };
}

// ── Per-slice apply ─────────────────────────────────────────────────────────

/**
 * Applies one slice inside one transaction:
 *   1. Acquire period advisory lock
 *   2. For each affected user: compute score, evaluate eligibility, upsert
 *   3. Rerank the slice
 *
 * Score recompute is from CANONICAL SOURCE (xp_events / user_progress_state /
 * user_brick_progress) — never from a running counter. This guarantees
 * determinism under replay and matches the M3c precedent.
 */
async function applySlice(prismaClient, slice) {
  const { definition, periodKey, userIds } = slice;
  await prismaClient.$transaction(async (tx) => {
    await acquirePeriodLock(tx, definition.leaderboardKey, periodKey);

    for (const userId of userIds) {
      // eslint-disable-next-line no-await-in-loop
      const score = await computeScore(definition, userId, periodKey, tx);
      // eslint-disable-next-line no-await-in-loop
      const elig = await evaluateEligibility(definition, userId, periodKey, tx);
      // eslint-disable-next-line no-await-in-loop
      await upsertState(tx, {
        leaderboardKey: definition.leaderboardKey,
        periodKey,
        userId,
        score: score.score,
        eligible: elig.eligible,
        tieBreakTimestamp: score.tie_break_timestamp,
        tieBreakEventId: score.tie_break_event_id,
      });
    }

    await rerank(tx, definition.leaderboardKey, periodKey);
  });
}

// ── Tick orchestration ──────────────────────────────────────────────────────

/**
 * Run one worker tick: poll both event streams, merge affected slices,
 * apply each slice in its own transaction, then advance cursors.
 *
 * Cursors only advance after ALL slices have committed — on a per-slice
 * failure, the cursor stays put and the next tick retries the entire batch.
 * (M3c-style "advance only on full success".)
 *
 * Options:
 *   limit — max events per stream per tick (default 500)
 */
async function processOneTick(prismaClient = prisma, options = {}) {
  const limit = options.limit ?? 500;
  const defs = await listActive(prismaClient);
  const { collectorXp, dexCompletion } = partitionDefinitions(defs);

  const [xpResult, dexResult] = await Promise.all([
    gatherXpEventAffects(prismaClient, collectorXp, limit),
    gatherBrickProgressAffects(prismaClient, dexCompletion, limit),
  ]);

  // Merge affected maps. Keys are unique by (leaderboardKey, periodKey).
  const allAffected = new Map(xpResult.affected);
  for (const [k, v] of dexResult.affected) {
    if (allAffected.has(k)) {
      // Same slice already in the map — merge userId sets.
      const existing = allAffected.get(k);
      for (const u of v.userIds) existing.userIds.add(u);
    } else {
      allAffected.set(k, v);
    }
  }

  // Apply each slice sequentially. (Per-period locks would let us parallelise
  // safely, but at MVP scale serial is simpler and gives deterministic test
  // behaviour.)
  for (const slice of allAffected.values()) {
    // eslint-disable-next-line no-await-in-loop
    await applySlice(prismaClient, slice);
  }

  // Advance cursors only after all slices committed successfully.
  if (xpResult.maxId !== null) {
    await setCursor(prismaClient, XP_CURSOR, xpResult.maxId);
  }
  if (dexResult.maxUpdatedAtMs !== null) {
    // Set to max - 1ms so any rows with the same ms get reprocessed next tick.
    // Recompute is idempotent so this is safe; protects against same-ms race.
    await setCursor(prismaClient, DEX_CURSOR, dexResult.maxUpdatedAtMs - 1);
  }

  return {
    xpEventsProcessed: xpResult.maxId !== null,
    dexProgressProcessed: dexResult.maxUpdatedAtMs !== null,
    sliceCount: allAffected.size,
  };
}

// ── Outer poll loop ─────────────────────────────────────────────────────────

async function runWorkerLoop() {
  console.log('[leaderboard-worker] starting');
  const POLL_INTERVAL_MS = 5000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await processOneTick(prisma);
    } catch (err) {
      console.error('[leaderboard-worker] tick error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = {
  processOneTick,
  resetCursors,
  // exposed for tests
  XP_CURSOR,
  DEX_CURSOR,
  gatherXpEventAffects,
  gatherBrickProgressAffects,
  applySlice,
  partitionDefinitions,
};

if (require.main === module) {
  runWorkerLoop().catch((err) => {
    console.error('[leaderboard-worker] fatal:', err);
    process.exit(1);
  });
}
