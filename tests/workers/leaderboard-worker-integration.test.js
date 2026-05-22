'use strict';

const prisma = require('../../src/lib/prisma');
const {
  processOneTick,
  resetCursors,
} = require('../../src/scripts/leaderboard-worker');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createdUserIds = [];
const createdBrickIds = [];

async function createUser(tag = 'lbw') {
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

async function upsertProgressState({ userId, totalXpConfirmed = 0, currentLevel = 1 }) {
  await prisma.$queryRawUnsafe(
    `INSERT INTO user_progress_state (user_id, total_xp_confirmed, current_level, highest_level_ever, updated_at)
     VALUES ($1, $2, $3, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET total_xp_confirmed = EXCLUDED.total_xp_confirmed,
           current_level      = EXCLUDED.current_level,
           highest_level_ever = GREATEST(user_progress_state.highest_level_ever, EXCLUDED.current_level),
           updated_at         = NOW()`,
    userId, totalXpConfirmed, currentLevel
  );
}

async function insertConfirmedXpEvent({ userId, amount, createdAt }) {
  const localDay = new Date(Date.UTC(
    createdAt.getUTCFullYear(),
    createdAt.getUTCMonth(),
    createdAt.getUTCDate()
  ));
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO xp_events
       (user_id, xp_amount, xp_delta_signed, reason, event_type,
        source_system, xp_confirmed, local_day_key, "createdAt")
     VALUES ($1, $2, $2, 'VOTE'::"XpReason", 'm3d_test', 'm3d_test', TRUE, $3::date, $4)
     RETURNING id`,
    userId, amount, localDay, createdAt
  );
  return BigInt(rows[0].id);
}

async function getPublishedBrickId() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM bricks WHERE status = 'PUBLISHED' LIMIT 1`
  );
  return rows[0]?.id || null;
}

async function setBrickProgress({ userId, brickId, stage, updatedAt }) {
  await prisma.$queryRawUnsafe(
    `INSERT INTO user_brick_progress (user_id, brick_id, stage, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (user_id, brick_id) DO UPDATE
       SET stage = EXCLUDED.stage, updated_at = EXCLUDED.updated_at`,
    userId, brickId, stage, updatedAt
  );
}

async function readState({ leaderboardKey, periodKey, userId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT user_id, score::float AS score, eligible, rank,
            tie_break_timestamp, tie_break_event_id
       FROM leaderboard_state
      WHERE leaderboard_key = $1 AND period_key = $2 AND user_id = $3`,
    leaderboardKey, periodKey, userId
  );
  return rows[0] || null;
}

async function readSlice({ leaderboardKey, periodKey }) {
  return prisma.$queryRawUnsafe(
    `SELECT user_id, score::float AS score, eligible, rank
       FROM leaderboard_state
      WHERE leaderboard_key = $1 AND period_key = $2
      ORDER BY rank ASC NULLS LAST, user_id ASC`,
    leaderboardKey, periodKey
  );
}

async function countXpEvents() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM xp_events`
  );
  return Number(rows[0].n);
}

async function clearSlice({ leaderboardKey, periodKey }) {
  await prisma.$queryRawUnsafe(
    `DELETE FROM leaderboard_state WHERE leaderboard_key = $1 AND period_key = $2`,
    leaderboardKey, periodKey
  );
}

async function cleanupUsers() {
  for (const id of createdUserIds) {
    await prisma.$queryRawUnsafe(`DELETE FROM leaderboard_state WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM user_brick_progress WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM xp_idempotency_keys WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM xp_events WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM user_progress_state WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM "User" WHERE id = $1`, id);
  }
  createdUserIds.length = 0;
  createdBrickIds.length = 0;
}

beforeEach(async () => { await resetCursors(prisma); });
afterEach(async () => { await cleanupUsers(); });
afterAll(async () => { await prisma.$disconnect(); });

// ---------------------------------------------------------------------------
// End-to-end happy path + the no-XP-event invariant
// ---------------------------------------------------------------------------

describe('leaderboard-worker — end-to-end', () => {
  test('processes xp_events, upserts state, reranks, and writes ZERO xp_events', async () => {
    const userA = await createUser('e2e_a');
    const userB = await createUser('e2e_b');
    await upsertProgressState({ userId: userA, totalXpConfirmed: 250, currentLevel: 5 });
    await upsertProgressState({ userId: userB, totalXpConfirmed: 500, currentLevel: 5 });

    const period = '2026-W21';
    // weekly_collector_xp requires min_weekly_actions: 5 — give each user 5
    // events distributed across the week.
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({
        userId: userA, amount: 50,
        createdAt: new Date(`2026-05-2${i}T10:00:00Z`),
      });
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({
        userId: userB, amount: 100,
        createdAt: new Date(`2026-05-2${i}T11:00:00Z`),
      });
    }

    const xpBefore = await countXpEvents();
    const result = await processOneTick(prisma);
    const xpAfter = await countXpEvents();

    // Worker must NEVER mint an xp_event.
    expect(xpAfter).toBe(xpBefore);

    expect(result.sliceCount).toBeGreaterThan(0);

    // Weekly board ranking.
    const weeklyRows = await readSlice({
      leaderboardKey: 'weekly_collector_xp', periodKey: period,
    });
    const byUserWeekly = Object.fromEntries(weeklyRows.map((r) => [String(r.user_id), r]));
    expect(byUserWeekly[String(userB)].rank).toBe(1);
    expect(byUserWeekly[String(userB)].score).toBe(500);
    expect(byUserWeekly[String(userA)].rank).toBe(2);
    expect(byUserWeekly[String(userA)].score).toBe(250);

    // Lifetime board ranking (uses user_progress_state).
    const lifetimeRows = await readSlice({
      leaderboardKey: 'lifetime_collector_xp', periodKey: 'LIFETIME',
    });
    const byUserLifetime = Object.fromEntries(lifetimeRows.map((r) => [String(r.user_id), r]));
    expect(byUserLifetime[String(userB)].rank).toBe(1);
    expect(byUserLifetime[String(userA)].rank).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Eligibility filter applied BEFORE ranking
// ---------------------------------------------------------------------------

describe('leaderboard-worker — eligibility filter', () => {
  test('user below weekly_collector_xp threshold gets eligible=false, rank=null', async () => {
    // weekly_collector_xp eligibility: min_level=3 AND min_weekly_actions=5
    const userIneligible = await createUser('elig_below');
    const userEligible   = await createUser('elig_above');
    // Both at level 5 so min_level passes; differ on weekly_actions.
    await upsertProgressState({ userId: userIneligible, totalXpConfirmed: 100, currentLevel: 5 });
    await upsertProgressState({ userId: userEligible,   totalXpConfirmed: 100, currentLevel: 5 });

    const period = '2026-W21';
    // userIneligible: only 2 events (< 5 needed).
    await insertConfirmedXpEvent({ userId: userIneligible, amount: 50, createdAt: new Date('2026-05-20T01:00:00Z') });
    await insertConfirmedXpEvent({ userId: userIneligible, amount: 50, createdAt: new Date('2026-05-20T02:00:00Z') });
    // userEligible: 6 events.
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({
        userId: userEligible, amount: 20,
        createdAt: new Date(`2026-05-2${i % 5}T0${i % 9}:00:00Z`),
      });
    }

    await processOneTick(prisma);

    const a = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: period, userId: userIneligible,
    });
    const b = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: period, userId: userEligible,
    });
    expect(a.eligible).toBe(false);
    expect(a.rank).toBeNull();
    expect(b.eligible).toBe(true);
    expect(b.rank).toBe(1);
  });

  test('user crossing eligibility threshold goes rank=null → ranked on next tick', async () => {
    const userId = await createUser('elig_cross');
    await upsertProgressState({ userId, totalXpConfirmed: 100, currentLevel: 5 });
    const period = '2026-W21';

    // Tick 1: insert 3 events — below 5-action threshold.
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({
        userId, amount: 30,
        createdAt: new Date(`2026-05-2${i}T08:00:00Z`),
      });
    }
    await processOneTick(prisma);
    let st = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: period, userId,
    });
    expect(st.eligible).toBe(false);
    expect(st.rank).toBeNull();

    // Tick 2: add 3 more events — now over threshold.
    for (let i = 3; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({
        userId, amount: 30,
        createdAt: new Date(`2026-05-2${i % 5}T09:00:00Z`),
      });
    }
    await processOneTick(prisma);
    st = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: period, userId,
    });
    expect(st.eligible).toBe(true);
    expect(st.rank).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Q9 UTC boundary
// ---------------------------------------------------------------------------

describe('leaderboard-worker — Q9 UTC period boundary', () => {
  test('event at period_end - 1s lands in old period; +1s lands in new period', async () => {
    const userA = await createUser('boundary_old');
    const userB = await createUser('boundary_new');
    // Lift both above weekly threshold so they appear ranked.
    await upsertProgressState({ userId: userA, totalXpConfirmed: 100, currentLevel: 5 });
    await upsertProgressState({ userId: userB, totalXpConfirmed: 100, currentLevel: 5 });

    // 5 events for each user, all on the same side of the boundary as their
    // marker event, so both clear min_weekly_actions=5.
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({
        userId: userA, amount: 10,
        createdAt: new Date(`2026-05-2${i % 5}T05:00:00Z`),
      });
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({
        userId: userB, amount: 10,
        createdAt: new Date(`2026-05-2${5 + i}T05:00:00Z`),
      });
    }
    // Marker events straddling the boundary.
    await insertConfirmedXpEvent({
      userId: userA, amount: 50,
      createdAt: new Date('2026-05-24T23:59:59Z'), // last second of 2026-W21
    });
    await insertConfirmedXpEvent({
      userId: userB, amount: 50,
      createdAt: new Date('2026-05-25T00:00:01Z'), // first second of 2026-W22
    });

    await processOneTick(prisma);

    const aOld = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: '2026-W21', userId: userA,
    });
    const aNew = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: '2026-W22', userId: userA,
    });
    const bOld = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: '2026-W21', userId: userB,
    });
    const bNew = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: '2026-W22', userId: userB,
    });

    expect(aOld.score).toBe(90);    // 4×10 + 50
    expect(aNew).toBeNull();         // no events in W22 for userA
    expect(bOld).toBeNull();         // no events in W21 for userB
    expect(bNew.score).toBe(90);     // 4×10 + 50

    await clearSlice({ leaderboardKey: 'weekly_collector_xp', periodKey: '2026-W22' });
  });
});

// ---------------------------------------------------------------------------
// Determinism — shuffled insert order produces same ranks
// ---------------------------------------------------------------------------

describe('leaderboard-worker — determinism', () => {
  test('shuffled xp_event insertion yields identical ranks', async () => {
    const ua = await createUser('det_a');
    const ub = await createUser('det_b');
    await upsertProgressState({ userId: ua, totalXpConfirmed: 100, currentLevel: 5 });
    await upsertProgressState({ userId: ub, totalXpConfirmed: 100, currentLevel: 5 });

    // Both users earn identical total but at different times.
    const aEvents = [
      { t: '2026-05-18T05:00:00Z', amt: 10 },
      { t: '2026-05-19T07:00:00Z', amt: 25 },
      { t: '2026-05-22T14:00:00Z', amt: 15 },
      { t: '2026-05-23T20:00:00Z', amt: 50 }, // last
      { t: '2026-05-20T20:00:00Z', amt: 10 },
      { t: '2026-05-21T20:00:00Z', amt: 10 },
    ];
    const bEvents = [
      // Same total (120) but with the LATEST event earlier (2026-05-21T20:00),
      // so ub should rank ahead of ua on Q5 tie-break.
      { t: '2026-05-18T05:00:00Z', amt: 10 },
      { t: '2026-05-19T07:00:00Z', amt: 25 },
      { t: '2026-05-20T14:00:00Z', amt: 15 },
      { t: '2026-05-20T15:00:00Z', amt: 50 },
      { t: '2026-05-20T16:00:00Z', amt: 10 },
      { t: '2026-05-21T20:00:00Z', amt: 10 }, // last (earlier than ua's last)
    ];

    // Insert ua in chronological order, ub in REVERSED order — the worker must
    // not care about insertion order, only event timestamps.
    for (const e of aEvents) {
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({ userId: ua, amount: e.amt, createdAt: new Date(e.t) });
    }
    for (const e of [...bEvents].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({ userId: ub, amount: e.amt, createdAt: new Date(e.t) });
    }

    await processOneTick(prisma);

    const a = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: '2026-W21', userId: ua,
    });
    const b = await readState({
      leaderboardKey: 'weekly_collector_xp', periodKey: '2026-W21', userId: ub,
    });
    expect(a.score).toBe(120);
    expect(b.score).toBe(120);
    // Q5 tie-break: ub reached the total earlier → ub rank 1.
    expect(b.rank).toBe(1);
    expect(a.rank).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Dex completion board picks up user_brick_progress updates
// ---------------------------------------------------------------------------

describe('leaderboard-worker — dex_completion_percent board', () => {
  test('user_brick_progress at stage=3 populates lifetime_dex_completion state', async () => {
    const userId = await createUser('dex_e2e');

    const brickId = await getPublishedBrickId();
    if (!brickId) {
      // Defensive: clean dev env should have published bricks; if not, skip.
      console.warn('No published brick available — skipping dex test');
      return;
    }
    await setBrickProgress({
      userId, brickId, stage: 3, updatedAt: new Date(),
    });

    await processOneTick(prisma);

    const st = await readState({
      leaderboardKey: 'lifetime_dex_completion', periodKey: 'LIFETIME', userId,
    });
    expect(st).not.toBeNull();
    expect(Number(st.score)).toBeGreaterThan(0);
    // Eligibility is gated by min_dex_completion_pct: 1, so >0 means eligible.
    expect(st.eligible).toBe(true);
    // The dev DB may have pre-existing user_brick_progress rows from prior
    // test runs — assert the user is ranked, but not necessarily rank 1.
    expect(st.rank).toBeGreaterThan(0);
  });
});
