'use strict';

const prisma = require('../../../../src/lib/prisma');
const {
  computeScore,
  scoreCollectorXpLifetime,
  scoreCollectorXpWeekly,
  scoreDexCompletion,
  ZERO_SCORE,
} = require('../../../../src/services/leaderboards/LeaderboardScoreService');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createdUserIds = [];

async function createUser(tag = 'score') {
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

async function insertConfirmedXpEvent({ userId, amount, createdAt, eventType = 'session_completion' }) {
  const localDay = new Date(Date.UTC(
    createdAt.getUTCFullYear(),
    createdAt.getUTCMonth(),
    createdAt.getUTCDate()
  ));
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO xp_events
       (user_id, xp_amount, xp_delta_signed, reason, event_type,
        source_system, xp_confirmed, local_day_key, "createdAt")
     VALUES ($1, $2, $2, 'VOTE'::"XpReason", $3, 'm3d_test', TRUE, $4::date, $5)
     RETURNING id, "createdAt" AS created_at`,
    userId, amount, eventType, localDay, createdAt
  );
  return rows[0];
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

async function cleanupUsers() {
  for (const id of createdUserIds) {
    await prisma.$queryRawUnsafe(`DELETE FROM user_brick_progress WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM xp_idempotency_keys WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM xp_events WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM user_progress_state WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM "User" WHERE id = $1`, id);
  }
  createdUserIds.length = 0;
}

afterEach(async () => { await cleanupUsers(); });
afterAll(async () => { await prisma.$disconnect(); });

// ---------------------------------------------------------------------------
// scoreCollectorXpLifetime
// ---------------------------------------------------------------------------

describe('LeaderboardScoreService.scoreCollectorXpLifetime', () => {
  test('returns ZERO_SCORE when user_progress_state has no row', async () => {
    const userId = await createUser('lifetime_empty');
    const result = await scoreCollectorXpLifetime(userId);
    expect(result).toEqual(ZERO_SCORE);
  });

  test('returns ZERO_SCORE when total_xp_confirmed = 0', async () => {
    const userId = await createUser('lifetime_zero');
    await upsertProgressState({ userId, totalXpConfirmed: 0 });
    const result = await scoreCollectorXpLifetime(userId);
    expect(result).toEqual(ZERO_SCORE);
  });

  test('returns the confirmed total and the latest contributing event id/timestamp', async () => {
    const userId = await createUser('lifetime_real');
    const t1 = new Date('2026-05-10T10:00:00Z');
    const t2 = new Date('2026-05-12T14:00:00Z'); // latest
    await insertConfirmedXpEvent({ userId, amount: 30, createdAt: t1 });
    const second = await insertConfirmedXpEvent({ userId, amount: 70, createdAt: t2 });
    await upsertProgressState({ userId, totalXpConfirmed: 100 });

    const result = await scoreCollectorXpLifetime(userId);
    expect(result.score).toBe(100);
    expect(result.tie_break_timestamp.toISOString()).toBe(t2.toISOString());
    expect(BigInt(result.tie_break_event_id)).toBe(BigInt(second.id));
  });
});

// ---------------------------------------------------------------------------
// scoreCollectorXpWeekly  (Q9 UTC boundary, Q5 tie-break)
// ---------------------------------------------------------------------------

describe('LeaderboardScoreService.scoreCollectorXpWeekly', () => {
  const PERIOD = '2026-W21'; // Monday 2026-05-18 00:00 UTC → Monday 2026-05-25 00:00 UTC

  test('returns ZERO_SCORE when user has no events in the period', async () => {
    const userId = await createUser('weekly_empty');
    const result = await scoreCollectorXpWeekly(userId, PERIOD);
    expect(result).toEqual(ZERO_SCORE);
  });

  test('Q9: event at period_end - 1s counts for OLD period; +1s counts for NEW period', async () => {
    const userA = await createUser('weekly_boundary_old');
    const userB = await createUser('weekly_boundary_new');

    const periodEndMinus1s = new Date('2026-05-24T23:59:59Z');
    const periodStartPlus1s = new Date('2026-05-25T00:00:01Z');

    await insertConfirmedXpEvent({ userId: userA, amount: 50, createdAt: periodEndMinus1s });
    await insertConfirmedXpEvent({ userId: userB, amount: 50, createdAt: periodStartPlus1s });

    const inOldPeriodA = await scoreCollectorXpWeekly(userA, '2026-W21');
    const inNewPeriodA = await scoreCollectorXpWeekly(userA, '2026-W22');
    const inOldPeriodB = await scoreCollectorXpWeekly(userB, '2026-W21');
    const inNewPeriodB = await scoreCollectorXpWeekly(userB, '2026-W22');

    expect(inOldPeriodA.score).toBe(50);
    expect(inNewPeriodA).toEqual(ZERO_SCORE);
    expect(inOldPeriodB).toEqual(ZERO_SCORE);
    expect(inNewPeriodB.score).toBe(50);
  });

  test('sums xp_delta_signed only for confirmed events in the period', async () => {
    const userId = await createUser('weekly_sum');
    await insertConfirmedXpEvent({ userId, amount: 30, createdAt: new Date('2026-05-18T01:00:00Z') });
    await insertConfirmedXpEvent({ userId, amount: 70, createdAt: new Date('2026-05-22T01:00:00Z') });
    await insertConfirmedXpEvent({ userId, amount: 200, createdAt: new Date('2026-05-26T01:00:00Z') }); // next week
    const result = await scoreCollectorXpWeekly(userId, PERIOD);
    expect(result.score).toBe(100);
  });

  test('Q5 tie-break: the LAST contributing event timestamp is recorded', async () => {
    const userId = await createUser('weekly_tiebreak');
    const tEarly = new Date('2026-05-18T10:00:00Z');
    const tLate  = new Date('2026-05-22T15:00:00Z');
    await insertConfirmedXpEvent({ userId, amount: 40, createdAt: tEarly });
    const last = await insertConfirmedXpEvent({ userId, amount: 30, createdAt: tLate });

    const result = await scoreCollectorXpWeekly(userId, PERIOD);
    expect(result.score).toBe(70);
    expect(result.tie_break_timestamp.toISOString()).toBe(tLate.toISOString());
    expect(BigInt(result.tie_break_event_id)).toBe(BigInt(last.id));
  });

  test('determinism: shuffled insertion order yields the same score and tie-break', async () => {
    const userA = await createUser('weekly_det_a');
    const userB = await createUser('weekly_det_b');

    const events = [
      { t: '2026-05-18T05:00:00Z', amt: 10 },
      { t: '2026-05-19T07:00:00Z', amt: 25 },
      { t: '2026-05-22T14:00:00Z', amt: 15 },
      { t: '2026-05-23T20:00:00Z', amt: 50 },
    ];

    // userA: insert in chronological order
    for (const e of events) {
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({ userId: userA, amount: e.amt, createdAt: new Date(e.t) });
    }

    // userB: insert in reverse order
    for (const e of [...events].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await insertConfirmedXpEvent({ userId: userB, amount: e.amt, createdAt: new Date(e.t) });
    }

    const ra = await scoreCollectorXpWeekly(userA, PERIOD);
    const rb = await scoreCollectorXpWeekly(userB, PERIOD);

    expect(ra.score).toBe(100);
    expect(rb.score).toBe(100);
    // Both users' tie_break_timestamp should be the LATEST event time (2026-05-23T20:00).
    expect(ra.tie_break_timestamp.toISOString()).toBe('2026-05-23T20:00:00.000Z');
    expect(rb.tie_break_timestamp.toISOString()).toBe('2026-05-23T20:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// scoreDexCompletion
// ---------------------------------------------------------------------------

describe('LeaderboardScoreService.scoreDexCompletion', () => {
  // Uses the existing bricks catalogue (seeded by earlier migrations / fixtures).
  // We just assert the score is a non-negative percent.

  test('returns ZERO_SCORE when user has no stage=3 rows', async () => {
    const userId = await createUser('dex_empty');
    const result = await scoreDexCompletion(userId);
    expect(result).toEqual(ZERO_SCORE);
  });

  test('returns a positive percent when the user has at least one stage=3 row', async () => {
    // Use a published brick from the existing catalogue (M2 seed leaves some).
    // If the dev DB has none, skip (a clean dev env will have at least the 5
    // M2 seed bricks, but defensively guard).
    const userId = await createUser('dex_partial');
    const published = await prisma.$queryRawUnsafe(
      `SELECT id FROM bricks WHERE status = 'PUBLISHED' LIMIT 1`
    );
    if (published.length === 0) {
      // No published bricks → denominator is 0, return without asserting.
      const result = await scoreDexCompletion(userId);
      expect(result).toEqual(ZERO_SCORE);
      return;
    }
    const brickId = published[0].id;
    await prisma.$queryRawUnsafe(
      `INSERT INTO user_brick_progress (user_id, brick_id, stage, created_at, updated_at)
       VALUES ($1, $2, 3, NOW(), NOW())
       ON CONFLICT (user_id, brick_id) DO UPDATE SET stage = 3, updated_at = NOW()`,
      userId, brickId
    );

    const result = await scoreDexCompletion(userId);
    expect(Number(result.score)).toBeGreaterThan(0);
    expect(result.tie_break_timestamp).not.toBeNull();
    expect(result.tie_break_event_id).toBeNull(); // documented: Dex has no event id
  });
});

// ---------------------------------------------------------------------------
// computeScore dispatcher + contribution stub
// ---------------------------------------------------------------------------

describe('LeaderboardScoreService.computeScore (dispatcher)', () => {
  test('routes collector_xp/lifetime correctly', async () => {
    const userId = await createUser('disp_lifetime');
    await upsertProgressState({ userId, totalXpConfirmed: 250 });
    await insertConfirmedXpEvent({ userId, amount: 250, createdAt: new Date('2026-05-10T00:00:00Z') });

    const result = await computeScore(
      { metricType: 'collector_xp', scope: 'lifetime' },
      userId,
      'LIFETIME'
    );
    expect(result.score).toBe(250);
  });

  test('routes collector_xp/weekly correctly', async () => {
    const userId = await createUser('disp_weekly');
    await insertConfirmedXpEvent({ userId, amount: 80, createdAt: new Date('2026-05-20T12:00:00Z') });

    const result = await computeScore(
      { metricType: 'collector_xp', scope: 'weekly' },
      userId,
      '2026-W21'
    );
    expect(result.score).toBe(80);
  });

  test('approved_contribution_weight is a stub returning ZERO_SCORE', async () => {
    const userId = await createUser('disp_contrib');
    const result = await computeScore(
      { metricType: 'approved_contribution_weight', scope: 'lifetime' },
      userId,
      'LIFETIME'
    );
    expect(result).toEqual(ZERO_SCORE);
  });

  test('throws on unknown metric_type', async () => {
    const userId = await createUser('disp_unknown');
    await expect(
      computeScore({ metricType: 'unknown_thing', scope: 'lifetime' }, userId, 'LIFETIME')
    ).rejects.toThrow(/unknown metric_type/);
  });
});
