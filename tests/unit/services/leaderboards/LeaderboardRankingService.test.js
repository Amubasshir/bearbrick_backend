'use strict';

const prisma = require('../../../../src/lib/prisma');
const {
  acquirePeriodLock,
  rerank,
  upsertState,
} = require('../../../../src/services/leaderboards/LeaderboardRankingService');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createdUserIds = [];
const TEST_KEY = 'm3d_test_ranking'; // not a seeded board; safe to write to

async function createUser(tag = 'rank') {
  const handle = `m3d_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const r = await prisma.$queryRawUnsafe(
    `INSERT INTO "User" (name, email, password, email_verified_at, timezone, "createdAt", "updatedAt")
     VALUES ($1, $2, 'x', NOW(), 'UTC', NOW(), NOW())
     RETURNING id`,
    handle, `${handle}@m3d.test`
  );
  const id = BigInt(r[0].id);
  createdUserIds.push(id);
  return id;
}

async function readState(periodKey) {
  return prisma.$queryRawUnsafe(
    `SELECT user_id, score::float AS score, eligible, rank,
            tie_break_timestamp, tie_break_event_id
       FROM leaderboard_state
      WHERE leaderboard_key = $1 AND period_key = $2
      ORDER BY rank ASC NULLS LAST, user_id ASC`,
    TEST_KEY, periodKey
  );
}

async function clearTestKey(periodKey) {
  await prisma.$queryRawUnsafe(
    `DELETE FROM leaderboard_state WHERE leaderboard_key = $1 AND period_key = $2`,
    TEST_KEY, periodKey
  );
}

async function cleanupUsers() {
  for (const id of createdUserIds) {
    await prisma.$queryRawUnsafe(`DELETE FROM leaderboard_state WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM "User" WHERE id = $1`, id);
  }
  createdUserIds.length = 0;
}

afterEach(async () => { await cleanupUsers(); });
afterAll(async () => { await prisma.$disconnect(); });

// ---------------------------------------------------------------------------
// rerank — primary ordering
// ---------------------------------------------------------------------------

describe('LeaderboardRankingService.rerank', () => {
  test('orders eligible users by score DESC and nulls ineligible rows\' ranks', async () => {
    const u1 = await createUser('rank_basic_1');
    const u2 = await createUser('rank_basic_2');
    const u3 = await createUser('rank_basic_3');
    const period = `T1_${Date.now()}`;

    await prisma.$transaction(async (tx) => {
      await acquirePeriodLock(tx, TEST_KEY, period);
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u1,
        score: 100, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T10:00:00Z'), tieBreakEventId: 1n,
      });
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u2,
        score: 300, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T10:00:00Z'), tieBreakEventId: 2n,
      });
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u3,
        score: 999, eligible: false, // ineligible
        tieBreakTimestamp: new Date('2026-05-20T10:00:00Z'), tieBreakEventId: 3n,
      });
      await rerank(tx, TEST_KEY, period);
    });

    const rows = await readState(period);
    const byUser = Object.fromEntries(rows.map((r) => [String(r.user_id), r]));
    expect(byUser[String(u2)].rank).toBe(1);
    expect(byUser[String(u2)].score).toBe(300);
    expect(byUser[String(u1)].rank).toBe(2);
    expect(byUser[String(u1)].score).toBe(100);
    expect(byUser[String(u3)].rank).toBeNull();
    expect(byUser[String(u3)].eligible).toBe(false);

    await clearTestKey(period);
  });
});

// ---------------------------------------------------------------------------
// rerank — Q5 tie-break ordering
// ---------------------------------------------------------------------------

describe('LeaderboardRankingService.rerank — Q5 tie-break ordering', () => {
  test('same score → earlier tie_break_timestamp ranks higher', async () => {
    const ua = await createUser('tb_ts_a');
    const ub = await createUser('tb_ts_b');
    const period = `T2_${Date.now()}`;

    await prisma.$transaction(async (tx) => {
      await acquirePeriodLock(tx, TEST_KEY, period);
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: ua,
        score: 100, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T15:00:00Z'), tieBreakEventId: 100n,
      });
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: ub,
        score: 100, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T10:00:00Z'), tieBreakEventId: 200n,
      });
      await rerank(tx, TEST_KEY, period);
    });

    const rows = await readState(period);
    const byUser = Object.fromEntries(rows.map((r) => [String(r.user_id), r]));
    // ub reached the score earlier → rank 1
    expect(byUser[String(ub)].rank).toBe(1);
    expect(byUser[String(ua)].rank).toBe(2);

    await clearTestKey(period);
  });

  test('same score AND same timestamp → earlier tie_break_event_id ranks higher', async () => {
    const ua = await createUser('tb_eid_a');
    const ub = await createUser('tb_eid_b');
    const ts = new Date('2026-05-20T10:00:00Z');
    const period = `T3_${Date.now()}`;

    await prisma.$transaction(async (tx) => {
      await acquirePeriodLock(tx, TEST_KEY, period);
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: ua,
        score: 100, eligible: true,
        tieBreakTimestamp: ts, tieBreakEventId: 999n,
      });
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: ub,
        score: 100, eligible: true,
        tieBreakTimestamp: ts, tieBreakEventId: 100n,
      });
      await rerank(tx, TEST_KEY, period);
    });

    const rows = await readState(period);
    const byUser = Object.fromEntries(rows.map((r) => [String(r.user_id), r]));
    // ub has lower event_id → rank 1
    expect(byUser[String(ub)].rank).toBe(1);
    expect(byUser[String(ua)].rank).toBe(2);

    await clearTestKey(period);
  });

  test('all three keys equal → stable user_id order (lower id ranks higher)', async () => {
    const ua = await createUser('tb_uid_a'); // earlier id
    const ub = await createUser('tb_uid_b'); // later id
    const ts = new Date('2026-05-20T10:00:00Z');
    const eid = 500n;
    const period = `T4_${Date.now()}`;

    await prisma.$transaction(async (tx) => {
      await acquirePeriodLock(tx, TEST_KEY, period);
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: ua,
        score: 100, eligible: true,
        tieBreakTimestamp: ts, tieBreakEventId: eid,
      });
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: ub,
        score: 100, eligible: true,
        tieBreakTimestamp: ts, tieBreakEventId: eid,
      });
      await rerank(tx, TEST_KEY, period);
    });

    const rows = await readState(period);
    const byUser = Object.fromEntries(rows.map((r) => [String(r.user_id), r]));
    // ua < ub → ua rank 1
    expect(byUser[String(ua)].rank).toBe(1);
    expect(byUser[String(ub)].rank).toBe(2);

    await clearTestKey(period);
  });
});

// ---------------------------------------------------------------------------
// rerank — eligibility crossings
// ---------------------------------------------------------------------------

describe('LeaderboardRankingService.rerank — eligibility crossings', () => {
  test('user crossing from ineligible→eligible joins the ranking without shifting others incorrectly', async () => {
    const u1 = await createUser('elig_cross_1');
    const u2 = await createUser('elig_cross_2'); // initially ineligible
    const u3 = await createUser('elig_cross_3');
    const period = `T5_${Date.now()}`;

    // Initial rerank: u1 rank 1 (300), u3 rank 2 (100), u2 ineligible.
    await prisma.$transaction(async (tx) => {
      await acquirePeriodLock(tx, TEST_KEY, period);
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u1,
        score: 300, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T10:00:00Z'), tieBreakEventId: 1n,
      });
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u2,
        score: 200, eligible: false,
        tieBreakTimestamp: new Date('2026-05-20T11:00:00Z'), tieBreakEventId: 2n,
      });
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u3,
        score: 100, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T12:00:00Z'), tieBreakEventId: 3n,
      });
      await rerank(tx, TEST_KEY, period);
    });

    let rows = await readState(period);
    let byUser = Object.fromEntries(rows.map((r) => [String(r.user_id), r]));
    expect(byUser[String(u1)].rank).toBe(1);
    expect(byUser[String(u3)].rank).toBe(2);
    expect(byUser[String(u2)].rank).toBeNull();

    // u2 crosses eligibility threshold; score 200 places between u1 and u3.
    await prisma.$transaction(async (tx) => {
      await acquirePeriodLock(tx, TEST_KEY, period);
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u2,
        score: 200, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T11:00:00Z'), tieBreakEventId: 2n,
      });
      await rerank(tx, TEST_KEY, period);
    });

    rows = await readState(period);
    byUser = Object.fromEntries(rows.map((r) => [String(r.user_id), r]));
    expect(byUser[String(u1)].rank).toBe(1); // unchanged
    expect(byUser[String(u2)].rank).toBe(2); // inserted
    expect(byUser[String(u3)].rank).toBe(3); // shifted down

    await clearTestKey(period);
  });

  test('eligible→ineligible reverses to rank=null without breaking neighbors', async () => {
    const u1 = await createUser('elig_drop_1');
    const u2 = await createUser('elig_drop_2');
    const period = `T6_${Date.now()}`;

    await prisma.$transaction(async (tx) => {
      await acquirePeriodLock(tx, TEST_KEY, period);
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u1,
        score: 100, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T10:00:00Z'), tieBreakEventId: 1n,
      });
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u2,
        score: 50, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T11:00:00Z'), tieBreakEventId: 2n,
      });
      await rerank(tx, TEST_KEY, period);
    });

    // Drop u1 to ineligible (perhaps banned, or thresholds moved).
    await prisma.$transaction(async (tx) => {
      await acquirePeriodLock(tx, TEST_KEY, period);
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId: u1,
        score: 100, eligible: false,
        tieBreakTimestamp: new Date('2026-05-20T10:00:00Z'), tieBreakEventId: 1n,
      });
      await rerank(tx, TEST_KEY, period);
    });

    const rows = await readState(period);
    const byUser = Object.fromEntries(rows.map((r) => [String(r.user_id), r]));
    expect(byUser[String(u1)].rank).toBeNull();
    expect(byUser[String(u2)].rank).toBe(1); // u2 now top eligible

    await clearTestKey(period);
  });
});

// ---------------------------------------------------------------------------
// upsertState idempotency
// ---------------------------------------------------------------------------

describe('LeaderboardRankingService.upsertState', () => {
  test('repeated upsert for same (lb, period, user) updates in place — no duplicates', async () => {
    const userId = await createUser('upsert');
    const period = `T7_${Date.now()}`;

    await prisma.$transaction(async (tx) => {
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId,
        score: 50, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T10:00:00Z'), tieBreakEventId: 1n,
      });
      await upsertState(tx, {
        leaderboardKey: TEST_KEY, periodKey: period, userId,
        score: 150, eligible: true,
        tieBreakTimestamp: new Date('2026-05-20T12:00:00Z'), tieBreakEventId: 2n,
      });
    });

    const rows = await readState(period);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(150);
    expect(BigInt(rows[0].tie_break_event_id)).toBe(2n);

    await clearTestKey(period);
  });
});
