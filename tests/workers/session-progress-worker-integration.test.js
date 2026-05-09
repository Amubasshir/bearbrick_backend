'use strict';

const { v4: uuidv4 } = require('uuid');
const prisma = require('../../src/lib/prisma');
const { createFreshUser } = require('../helpers/dex');
const { processOneVote } = require('../../src/scripts/session-progress-worker');

// Per-test, hermetic worker runner. Bypasses the global worker_cursors row so
// parallel jest workers running session worker tests cannot trample each other.
async function processVoteEvents(prismaClient, userIds = null) {
  const xpCfgRows = await prismaClient.$queryRawUnsafe(
    `SELECT config FROM xp_config_versions WHERE is_active = TRUE
      ORDER BY version DESC LIMIT 1`
  );
  const cfg = xpCfgRows[0]?.config?.xpAmounts || {};
  const xpConfig = {
    morningCompletionXp: cfg.session_completion_morning ?? 50,
    eveningCompletionXp: cfg.session_completion_evening ?? 75,
    streakBonusXp: cfg.streak_bonus ?? 5,
  };

  const filter = Array.isArray(userIds) && userIds.length > 0;
  const sql = `
    SELECT ve.id, ve.user_id, ve.brick_id, ve.vote_type, ve."createdAt" AS created_at,
           u.timezone
      FROM vote_events ve
      JOIN "User" u ON u.id = ve.user_id
     ${filter ? `WHERE ve.user_id = ANY($1::bigint[])` : ''}
     ORDER BY ve."createdAt" ASC, ve.id ASC
  `;
  const events = filter
    ? await prismaClient.$queryRawUnsafe(sql, userIds.map((id) => BigInt(id)))
    : await prismaClient.$queryRawUnsafe(sql);

  for (const ev of events) {
    const userIdBig = BigInt(ev.user_id);
    await prismaClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1)`, userIdBig);
      await processOneVote(tx, ev, xpConfig);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setUserTimezone(userId, tz) {
  await prisma.$queryRawUnsafe(
    `UPDATE "User" SET timezone = $2 WHERE id = $1`,
    BigInt(userId),
    tz
  );
}

async function createPublishedBrick({ name = 'Test Brick' } = {}) {
  const id = uuidv4();
  // Status PROTOTYPE: this brick is wired into a session set via raw SQL,
  // which doesn't gate on status. Keeping it out of the PUBLISHED pool
  // avoids polluting global counts (e.g. /dex/bricks/featured pagination,
  // DexStatsService.completion_pct denominators) that other test suites
  // assert against.
  await prisma.brick.create({
    data: {
      id,
      name,
      descriptionShort: 'Test brick for sessions worker',
      status: 'PROTOTYPE',
      releasedAt: new Date(),
    },
  });
  await prisma.brickPriceState.create({
    data: {
      brickId: id,
      baselinePrice: 100,
      livePrice: 100,
      currentCycleId: uuidv4(),
      cycleStartPrice: 100,
      cycleStartedAt: new Date(),
    },
  });
  return id;
}

async function createRotationCycle() {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO session_rotation_cycles (started_at, pool_size)
     VALUES (NOW(), 0)
     RETURNING id`
  );
  return rows[0].id;
}

async function createSessionSet({ localDayKey, kind, brickIds, rotationCycleId }) {
  const setRows = await prisma.$queryRawUnsafe(
    `INSERT INTO daily_session_sets (local_day_key, kind, rotation_cycle_id)
     VALUES ($1::date, $2::"SessionKind", $3::uuid)
     RETURNING id`,
    localDayKey,
    kind,
    rotationCycleId
  );
  const setId = setRows[0].id;
  for (let i = 0; i < brickIds.length; i++) {
    await prisma.$queryRawUnsafe(
      `INSERT INTO daily_session_set_items
         (session_set_id, brick_id, slot_index, rotation_cycle_id)
       VALUES ($1::uuid, $2, $3, $4::uuid)`,
      setId,
      brickIds[i],
      i,
      rotationCycleId
    );
  }
  return setId;
}

async function insertVoteEvent({ userId, brickId, voteType = 'FAIR', createdAt }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO vote_events
       (user_id, brick_id, vote_type, live_price_at_vote,
        fair_range_lower, fair_range_upper, base_step_at_vote,
        user_weight_at_vote, cycle_id, "createdAt")
     VALUES ($1, $2, $3::"VoteType", 100, 95, 105, 7, 1.0, $4, $5)
     RETURNING id`,
    BigInt(userId),
    brickId,
    voteType,
    uuidv4(),
    createdAt
  );
  return BigInt(rows[0].id);
}

async function getActiveVote(userId, brickId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM active_votes WHERE user_id = $1 AND brick_id = $2`,
    BigInt(userId),
    brickId
  );
  return rows[0] || null;
}

async function getUserSessionProgress(userId, sessionSetId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM user_session_progress
     WHERE user_id = $1 AND session_set_id = $2::uuid`,
    BigInt(userId),
    sessionSetId
  );
  return rows[0] || null;
}

async function getCompletionEvents(userId) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM session_completion_events
     WHERE user_id = $1
     ORDER BY created_at ASC, id ASC`,
    BigInt(userId)
  );
}

async function getStreak(userId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM user_streak_state WHERE user_id = $1`,
    BigInt(userId)
  );
  return rows[0] || null;
}

async function getSessionXpEvents(userId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, xp_delta_signed, idempotency_key, xp_confirmed
     FROM xp_events
     WHERE user_id = $1
       AND event_type IN ('session_completion', 'streak_bonus')
     ORDER BY id ASC`,
    BigInt(userId)
  );
}

async function resetWorkerCursor() {
  await prisma.$queryRawUnsafe(
    `INSERT INTO worker_cursors (worker_name, last_processed_id, "updatedAt")
     VALUES ('session-progress-worker', 0, NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_processed_id = 0, "updatedAt" = NOW()`
  );
}

// Pick deterministic timestamps that cleanly fall in UTC morning / dead / evening windows.
const UTC_MORNING = (dateStr) => new Date(`${dateStr}T10:00:00Z`); // 10 AM UTC = morning
const UTC_DEAD_AFTER = (dateStr) => new Date(`${dateStr}T16:00:00Z`); // 4 PM UTC = dead
const UTC_EVENING = (dateStr) => new Date(`${dateStr}T20:00:00Z`); // 8 PM UTC = evening

beforeEach(async () => {
  await resetWorkerCursor();
  // Wipe only the 2099-keyed sets this file owns. Other test files use real
  // "today" dates and must not be disturbed by parallel jest workers.
  await prisma.$queryRawUnsafe(
    `DELETE FROM daily_session_sets WHERE local_day_key >= '2099-01-01'`
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// active_votes UPSERT — happens regardless of session membership
// ---------------------------------------------------------------------------

describe('session-progress-worker — active_votes UPSERT', () => {
  test('vote on a brick not in any session set still upserts active_votes', async () => {
    const { userId } = await createFreshUser('av1');
    await setUserTimezone(userId, 'UTC');
    const brickId = await createPublishedBrick();

    await insertVoteEvent({
      userId,
      brickId,
      voteType: 'FAIR',
      createdAt: UTC_MORNING('2099-05-08'),
    });

    await processVoteEvents(prisma, [userId]);

    const av = await getActiveVote(userId, brickId);
    expect(av).not.toBeNull();
    expect(av.current_vote_type).toBe('FAIR');
    expect(Number(av.vote_count_for_brick)).toBe(1);
  });

  test('re-voting same brick with a different stance updates active_votes (not duplicates)', async () => {
    const { userId } = await createFreshUser('av2');
    await setUserTimezone(userId, 'UTC');
    const brickId = await createPublishedBrick();

    await insertVoteEvent({
      userId, brickId, voteType: 'FAIR',
      createdAt: UTC_MORNING('2099-05-08'),
    });
    await insertVoteEvent({
      userId, brickId, voteType: 'OVER',
      createdAt: UTC_MORNING('2099-05-09'),
    });

    await processVoteEvents(prisma, [userId]);

    const av = await getActiveVote(userId, brickId);
    expect(av.current_vote_type).toBe('OVER');
    expect(Number(av.vote_count_for_brick)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Dead window — no session progress
// ---------------------------------------------------------------------------

describe('session-progress-worker — dead window', () => {
  test('vote in dead window updates active_votes but does not advance progress', async () => {
    const { userId } = await createFreshUser('dead1');
    await setUserTimezone(userId, 'UTC');
    const brickId = await createPublishedBrick();
    const cycleId = await createRotationCycle();

    const setId = await createSessionSet({
      localDayKey: '2099-05-08',
      kind: 'MORNING',
      brickIds: [brickId],
      rotationCycleId: cycleId,
    });

    await insertVoteEvent({
      userId, brickId, voteType: 'FAIR',
      createdAt: UTC_DEAD_AFTER('2099-05-08'), // 4 PM UTC = dead window
    });

    await processVoteEvents(prisma, [userId]);

    expect(await getActiveVote(userId, brickId)).not.toBeNull();
    expect(await getUserSessionProgress(userId, setId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Morning 7 completion → completion event, XP, streak
// ---------------------------------------------------------------------------

describe('session-progress-worker — Morning 7 completion', () => {
  test('completing 7/7 emits completion event + XP + streak +1', async () => {
    const { userId } = await createFreshUser('m7done');
    await setUserTimezone(userId, 'UTC');
    const cycleId = await createRotationCycle();

    const brickIds = [];
    for (let i = 0; i < 7; i++) brickIds.push(await createPublishedBrick());

    const setId = await createSessionSet({
      localDayKey: '2099-05-08',
      kind: 'MORNING',
      brickIds,
      rotationCycleId: cycleId,
    });

    for (const brickId of brickIds) {
      await insertVoteEvent({
        userId, brickId, voteType: 'FAIR',
        createdAt: UTC_MORNING('2099-05-08'),
      });
    }

    await processVoteEvents(prisma, [userId]);

    const progress = await getUserSessionProgress(userId, setId);
    expect(Number(progress.partial_count)).toBe(7);
    expect(progress.completed_at).not.toBeNull();

    const completions = await getCompletionEvents(userId);
    expect(completions.length).toBe(1);
    expect(completions[0].kind).toBe('MORNING');

    const streak = await getStreak(userId);
    expect(Number(streak.morning_streak)).toBe(1);

    const xp = await getSessionXpEvents(userId);
    const types = xp.map((e) => e.event_type).sort();
    expect(types).toEqual(['session_completion', 'streak_bonus']);
    for (const e of xp) {
      expect(e.xp_confirmed).toBe(true);
    }
  });

  test('partial completion (6/7) does NOT emit completion event or streak credit', async () => {
    const { userId } = await createFreshUser('m7part');
    await setUserTimezone(userId, 'UTC');
    const cycleId = await createRotationCycle();
    const brickIds = [];
    for (let i = 0; i < 7; i++) brickIds.push(await createPublishedBrick());
    const setId = await createSessionSet({
      localDayKey: '2099-05-08', kind: 'MORNING',
      brickIds, rotationCycleId: cycleId,
    });

    for (let i = 0; i < 6; i++) {
      await insertVoteEvent({
        userId, brickId: brickIds[i], voteType: 'FAIR',
        createdAt: UTC_MORNING('2099-05-08'),
      });
    }

    await processVoteEvents(prisma, [userId]);

    const progress = await getUserSessionProgress(userId, setId);
    expect(Number(progress.partial_count)).toBe(6);
    expect(progress.completed_at).toBeNull();
    expect((await getCompletionEvents(userId)).length).toBe(0);
    expect(await getStreak(userId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Re-vote on same brick — no double count
// ---------------------------------------------------------------------------

describe('session-progress-worker — no double count on re-vote', () => {
  test('voting same brick in same set twice counts once toward progress', async () => {
    const { userId } = await createFreshUser('dup1');
    await setUserTimezone(userId, 'UTC');
    const cycleId = await createRotationCycle();
    const brickIds = [];
    for (let i = 0; i < 7; i++) brickIds.push(await createPublishedBrick());
    const setId = await createSessionSet({
      localDayKey: '2099-05-08', kind: 'MORNING',
      brickIds, rotationCycleId: cycleId,
    });

    // Vote twice on the same brick
    await insertVoteEvent({
      userId, brickId: brickIds[0], voteType: 'FAIR',
      createdAt: new Date('2099-05-08T10:00:00Z'),
    });
    await insertVoteEvent({
      userId, brickId: brickIds[0], voteType: 'OVER',
      createdAt: new Date('2099-05-08T10:01:00Z'),
    });

    await processVoteEvents(prisma, [userId]);

    const progress = await getUserSessionProgress(userId, setId);
    expect(Number(progress.partial_count)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotent rerun
// ---------------------------------------------------------------------------

describe('session-progress-worker — idempotent rerun', () => {
  test('running worker twice on the same vote events produces no duplicate XP', async () => {
    const { userId } = await createFreshUser('idem1');
    await setUserTimezone(userId, 'UTC');
    const cycleId = await createRotationCycle();
    const brickIds = [];
    for (let i = 0; i < 7; i++) brickIds.push(await createPublishedBrick());
    await createSessionSet({
      localDayKey: '2099-05-08', kind: 'MORNING',
      brickIds, rotationCycleId: cycleId,
    });

    for (const brickId of brickIds) {
      await insertVoteEvent({
        userId, brickId, voteType: 'FAIR',
        createdAt: UTC_MORNING('2099-05-08'),
      });
    }

    await processVoteEvents(prisma, [userId]);
    const xp1 = await getSessionXpEvents(userId);

    // Reset cursor and rerun — should re-process but produce no duplicates
    await resetWorkerCursor();
    await processVoteEvents(prisma, [userId]);
    const xp2 = await getSessionXpEvents(userId);

    expect(xp2.length).toBe(xp1.length);
    expect((await getCompletionEvents(userId)).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Streak progression across days
// ---------------------------------------------------------------------------

describe('session-progress-worker — streak progression', () => {
  test('completing two consecutive Morning sessions advances streak to 2', async () => {
    const { userId } = await createFreshUser('streak1');
    await setUserTimezone(userId, 'UTC');
    const cycleId = await createRotationCycle();

    // Day 1: 7 bricks
    const day1Bricks = [];
    for (let i = 0; i < 7; i++) day1Bricks.push(await createPublishedBrick());
    await createSessionSet({
      localDayKey: '2099-05-08', kind: 'MORNING',
      brickIds: day1Bricks, rotationCycleId: cycleId,
    });
    // Day 2: 7 different bricks
    const day2Bricks = [];
    for (let i = 0; i < 7; i++) day2Bricks.push(await createPublishedBrick());
    await createSessionSet({
      localDayKey: '2099-05-09', kind: 'MORNING',
      brickIds: day2Bricks, rotationCycleId: cycleId,
    });

    for (const b of day1Bricks) {
      await insertVoteEvent({
        userId, brickId: b, voteType: 'FAIR',
        createdAt: UTC_MORNING('2099-05-08'),
      });
    }
    for (const b of day2Bricks) {
      await insertVoteEvent({
        userId, brickId: b, voteType: 'FAIR',
        createdAt: UTC_MORNING('2099-05-09'),
      });
    }

    await processVoteEvents(prisma, [userId]);

    const streak = await getStreak(userId);
    expect(Number(streak.morning_streak)).toBe(2);
  });

  test('skipping a day resets Morning streak to 1 on next completion', async () => {
    const { userId } = await createFreshUser('streak2');
    await setUserTimezone(userId, 'UTC');
    const cycleId = await createRotationCycle();

    const day1Bricks = [];
    for (let i = 0; i < 7; i++) day1Bricks.push(await createPublishedBrick());
    await createSessionSet({
      localDayKey: '2099-05-08', kind: 'MORNING',
      brickIds: day1Bricks, rotationCycleId: cycleId,
    });
    // Skip 2099-05-09. Day 3 set:
    const day3Bricks = [];
    for (let i = 0; i < 7; i++) day3Bricks.push(await createPublishedBrick());
    await createSessionSet({
      localDayKey: '2099-05-10', kind: 'MORNING',
      brickIds: day3Bricks, rotationCycleId: cycleId,
    });

    for (const b of day1Bricks) {
      await insertVoteEvent({
        userId, brickId: b, voteType: 'FAIR',
        createdAt: UTC_MORNING('2099-05-08'),
      });
    }
    for (const b of day3Bricks) {
      await insertVoteEvent({
        userId, brickId: b, voteType: 'FAIR',
        createdAt: UTC_MORNING('2099-05-10'),
      });
    }

    await processVoteEvents(prisma, [userId]);

    const streak = await getStreak(userId);
    expect(Number(streak.morning_streak)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Morning vs Evening independence
// ---------------------------------------------------------------------------

describe('session-progress-worker — morning vs evening independence', () => {
  test('vote in 8 PM UTC on a Morning-set brick does NOT advance Morning progress', async () => {
    const { userId } = await createFreshUser('me1');
    await setUserTimezone(userId, 'UTC');
    const cycleId = await createRotationCycle();
    const brickId = await createPublishedBrick();
    const morningSetId = await createSessionSet({
      localDayKey: '2099-05-08', kind: 'MORNING',
      brickIds: [brickId], rotationCycleId: cycleId,
    });

    await insertVoteEvent({
      userId, brickId, voteType: 'FAIR',
      createdAt: UTC_EVENING('2099-05-08'), // 8 PM UTC = evening window
    });

    await processVoteEvents(prisma, [userId]);

    expect(await getUserSessionProgress(userId, morningSetId)).toBeNull();
  });
});
