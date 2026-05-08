'use strict';

const prisma = require('../../lib/prisma');
const { computeLocalDayKey, resolveSessionWindow, toDayKeyString } = require('../../lib/sessions');

const TARGETS = { MORNING: 7, EVENING: 11 };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic non-cryptographic hash of a string seed → unsigned 32-bit int.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seedInt) {
  let a = seedInt | 0;
  return function rng() {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic seeded shuffle + take-first-N. Same `seed` → same output.
 */
function pickBricksForSet(eligibleBrickIds, count, seed) {
  const arr = [...new Set(eligibleBrickIds)];
  const rng = mulberry32(fnv1a(String(seed)));
  // Fisher-Yates with a stable seeded RNG
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

// ---------------------------------------------------------------------------
// Rotation cycle helpers
// ---------------------------------------------------------------------------

async function getOrCreateActiveCycle(tx) {
  const open = await tx.$queryRawUnsafe(
    `SELECT id FROM session_rotation_cycles
      WHERE ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1`
  );
  if (open.length > 0) return open[0].id;
  const created = await tx.$queryRawUnsafe(
    `INSERT INTO session_rotation_cycles (started_at, pool_size)
     VALUES (NOW(), 0)
     RETURNING id`
  );
  return created[0].id;
}

async function listEligibleBricksRemaining(tx, rotationCycleId, alsoExcludeBrickIds = []) {
  const used = await tx.$queryRawUnsafe(
    `SELECT brick_id FROM daily_session_set_items WHERE rotation_cycle_id = $1::uuid`,
    rotationCycleId
  );
  const usedSet = new Set(used.map((r) => r.brick_id));
  for (const id of alsoExcludeBrickIds) usedSet.add(id);

  const eligible = await tx.$queryRawUnsafe(
    `SELECT id FROM bricks WHERE status = 'PUBLISHED'`
  );
  return eligible.map((r) => r.id).filter((id) => !usedSet.has(id));
}

async function rotateCycleIfExhausted(tx, currentCycleId, neededCount) {
  const remaining = await listEligibleBricksRemaining(tx, currentCycleId);
  if (remaining.length >= neededCount) return currentCycleId;
  // Close the current cycle, open a new one
  await tx.$queryRawUnsafe(
    `UPDATE session_rotation_cycles SET ended_at = NOW() WHERE id = $1::uuid AND ended_at IS NULL`,
    currentCycleId
  );
  const created = await tx.$queryRawUnsafe(
    `INSERT INTO session_rotation_cycles (started_at, pool_size)
     VALUES (NOW(), 0)
     RETURNING id`
  );
  return created[0].id;
}

// ---------------------------------------------------------------------------
// Core: get-or-build a session set for a (localDayKey, kind)
// ---------------------------------------------------------------------------

function dayKeyToISO(value) {
  return toDayKeyString(value);
}

/**
 * Race-safe JIT: returns the (localDayKey, kind) set, building it once if
 * missing. Inserts brick items deterministically.
 */
async function getOrBuildSetForDay(localDayKey, kind, txOrPrisma = prisma) {
  const tx = txOrPrisma;
  const dayIso = dayKeyToISO(localDayKey);
  const target = TARGETS[kind];
  if (!target) throw new Error(`Unknown session kind: ${kind}`);

  // Fast path
  const existing = await tx.$queryRawUnsafe(
    `SELECT id, rotation_cycle_id FROM daily_session_sets
      WHERE local_day_key = $1::date AND kind = $2::"SessionKind"`,
    dayIso, kind
  );
  if (existing.length > 0) return existing[0].id;

  // Build path
  let cycleId = await getOrCreateActiveCycle(tx);

  // For Evening on the same day, exclude any bricks already used by Morning
  let alsoExclude = [];
  if (kind === 'EVENING') {
    const morningSet = await tx.$queryRawUnsafe(
      `SELECT id FROM daily_session_sets
        WHERE local_day_key = $1::date AND kind = 'MORNING'`,
      dayIso
    );
    if (morningSet.length > 0) {
      const morningItems = await tx.$queryRawUnsafe(
        `SELECT brick_id FROM daily_session_set_items WHERE session_set_id = $1::uuid`,
        morningSet[0].id
      );
      alsoExclude = morningItems.map((r) => r.brick_id);
    }
  }

  cycleId = await rotateCycleIfExhausted(tx, cycleId, target);
  const eligible = await listEligibleBricksRemaining(tx, cycleId, alsoExclude);
  const seed = `${cycleId}:${dayIso}:${kind}`;
  const picked = pickBricksForSet(eligible, target, seed);

  // Insert the set, race-safely. If another caller already inserted, we re-fetch.
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO daily_session_sets (local_day_key, kind, rotation_cycle_id)
     VALUES ($1::date, $2::"SessionKind", $3::uuid)
     ON CONFLICT (local_day_key, kind) DO NOTHING
     RETURNING id`,
    dayIso, kind, cycleId
  );

  if (inserted.length === 0) {
    const refetch = await tx.$queryRawUnsafe(
      `SELECT id FROM daily_session_sets
        WHERE local_day_key = $1::date AND kind = $2::"SessionKind"`,
      dayIso, kind
    );
    return refetch[0].id;
  }

  const setId = inserted[0].id;

  // Insert items (no-op if already present from a concurrent build)
  for (let i = 0; i < picked.length; i++) {
    await tx.$queryRawUnsafe(
      `INSERT INTO daily_session_set_items
         (session_set_id, brick_id, slot_index, rotation_cycle_id)
       VALUES ($1::uuid, $2, $3, $4::uuid)
       ON CONFLICT DO NOTHING`,
      setId, picked[i], i, cycleId
    );
  }

  return setId;
}

// ---------------------------------------------------------------------------
// Read API: today's view for a user
// ---------------------------------------------------------------------------

async function getTodaySetForUser(userId) {
  const userRows = await prisma.$queryRawUnsafe(
    `SELECT id, timezone FROM "User" WHERE id = $1`,
    BigInt(userId)
  );
  if (userRows.length === 0) throw new Error('User not found');
  const timezone = userRows[0].timezone || 'UTC';
  const now = new Date();
  const localDayKey = computeLocalDayKey(now, timezone);
  const dayIso = toDayKeyString(localDayKey);
  const currentWindow = resolveSessionWindow(now, timezone);

  const morningSetId = await getOrBuildSetForDay(localDayKey, 'MORNING', prisma);
  const eveningSetId = await getOrBuildSetForDay(localDayKey, 'EVENING', prisma);

  const [morningItems, eveningItems] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT brick_id FROM daily_session_set_items
        WHERE session_set_id = $1::uuid
        ORDER BY slot_index ASC`,
      morningSetId
    ),
    prisma.$queryRawUnsafe(
      `SELECT brick_id FROM daily_session_set_items
        WHERE session_set_id = $1::uuid
        ORDER BY slot_index ASC`,
      eveningSetId
    ),
  ]);

  const morningProgress = await prisma.$queryRawUnsafe(
    `SELECT partial_count, completed_at, expired_at
       FROM user_session_progress
      WHERE user_id = $1 AND session_set_id = $2::uuid`,
    BigInt(userId), morningSetId
  );
  const eveningProgress = await prisma.$queryRawUnsafe(
    `SELECT partial_count, completed_at, expired_at
       FROM user_session_progress
      WHERE user_id = $1 AND session_set_id = $2::uuid`,
    BigInt(userId), eveningSetId
  );

  const streakRows = await prisma.$queryRawUnsafe(
    `SELECT morning_streak, evening_streak FROM user_streak_state WHERE user_id = $1`,
    BigInt(userId)
  );

  function toView(items, target, progressRows) {
    const p = progressRows[0];
    return {
      brick_ids: items.map((r) => r.brick_id),
      target,
      partial_count: p ? Number(p.partial_count) : 0,
      completed: !!(p && p.completed_at),
      expired: !!(p && p.expired_at),
    };
  }

  return {
    local_day_key: dayIso,
    timezone,
    current_window: currentWindow,
    morning: toView(morningItems, TARGETS.MORNING, morningProgress),
    evening: toView(eveningItems, TARGETS.EVENING, eveningProgress),
    streaks: {
      morning: streakRows.length ? Number(streakRows[0].morning_streak) : 0,
      evening: streakRows.length ? Number(streakRows[0].evening_streak) : 0,
    },
  };
}

module.exports = {
  pickBricksForSet,
  getOrBuildSetForDay,
  getTodaySetForUser,
  TARGETS,
};
