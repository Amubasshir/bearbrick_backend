'use strict';

// A5 worker integration tests (DB) for the two per-entity bounty workers:
//   - auto-bounty-generator-worker: generates OPEN bounties for missing brick
//     fields, idempotent re-run, auto-closes on a filled field (Q13), respects
//     the PUBLISHED eligibility filter.
//   - daily-submission-counter-reset-worker: 5 AM-local day-boundary reset of
//     daily_submission_count, with UTC fallback, scoped per user.
//
// The monthly-budget-reset worker is tested in
// tests/services/bounties/money-transactions.test.js (it owns global
// admin_settings). Neither worker here touches global singletons, so this file
// is parallel-safe. Rows are tracked + removed by the shared helpers cleanup.

const {
  prisma, createUser, createBrick, cleanup, instanceIdByType, statsFor,
} = require('../services/bounties/helpers');
const Inst = require('../../src/services/bounties/BountyInstanceService');
const Generator = require('../../src/scripts/auto-bounty-generator-worker');
const DailyReset = require('../../src/scripts/daily-submission-counter-reset-worker');
const { computeLocalDayKey, toDayKeyString } = require('../../src/lib/sessions');

afterAll(cleanup);

// ---------------------------------------------------------------------------
// auto-bounty-generator-worker
// ---------------------------------------------------------------------------
describe('auto-bounty-generator-worker.processOneTick', () => {
  test('creates one OPEN bounty per missing field on a fresh brick', async () => {
    const brickId = await createBrick(); // all 8 target fields null
    const res = await Generator.processOneTick(prisma, { brickIds: [brickId] });
    expect(res.scanned).toBe(1);
    expect(res.created).toBe(8);
    expect(res.closed).toBe(0);
    expect(await Inst.countOpenForBrick(prisma, brickId)).toBe(8);
  });

  test('re-running is idempotent — no duplicate instances', async () => {
    const brickId = await createBrick();
    await Generator.processOneTick(prisma, { brickIds: [brickId] });
    const res2 = await Generator.processOneTick(prisma, { brickIds: [brickId] });
    expect(res2.created).toBe(0);
    expect(await Inst.countOpenForBrick(prisma, brickId)).toBe(8);
  });

  test('only generates for fields that are actually missing', async () => {
    const brickId = await createBrick({ fields: { release_year: 2019, notes: 'preset' } });
    const res = await Generator.processOneTick(prisma, { brickIds: [brickId] });
    expect(res.created).toBe(6); // 8 - release_year - notes
    expect(await instanceIdByType(brickId, 'RELEASE_YEAR')).toBeNull();
    expect(await instanceIdByType(brickId, 'NOTES_CONTEXT')).toBeNull();
    expect(await instanceIdByType(brickId, 'PACKAGING_FRONT')).not.toBeNull();
  });

  test('auto-closes an OPEN bounty once its field is filled directly (Q13)', async () => {
    const brickId = await createBrick();
    await Generator.processOneTick(prisma, { brickIds: [brickId] });
    const instId = await instanceIdByType(brickId, 'RELEASE_YEAR');

    // Simulate a direct admin edit filling the field.
    await prisma.$executeRawUnsafe(
      `UPDATE bricks SET release_year = 2020, updated_at = NOW() WHERE id = $1`, brickId);

    const res = await Generator.processOneTick(prisma, { brickIds: [brickId] });
    expect(res.created).toBe(0); // field now filled, nothing new
    expect(res.closed).toBe(1);
    expect(await Inst.countOpenForBrick(prisma, brickId)).toBe(7);

    const inst = await prisma.$queryRawUnsafe(
      `SELECT status FROM bounty_instances WHERE id = $1::uuid`, instId);
    expect(inst[0].status).toBe('CLOSED');
  });

  test('skips non-PUBLISHED bricks (eligibility filter)', async () => {
    const brickId = await createBrick();
    await prisma.$executeRawUnsafe(
      `UPDATE bricks SET status = 'UNRELEASED' WHERE id = $1`, brickId);
    const res = await Generator.processOneTick(prisma, { brickIds: [brickId] });
    expect(res.scanned).toBe(0);
    expect(res.created).toBe(0);
    expect(await Inst.countOpenForBrick(prisma, brickId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// daily-submission-counter-reset-worker
// ---------------------------------------------------------------------------
async function seedStats(userId, { count, resetAtDayKey }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_bounty_stats (user_id, daily_submission_count, daily_submission_reset_at, updated_at)
     VALUES ($1, $2, $3::date, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       daily_submission_count = $2, daily_submission_reset_at = $3::date, updated_at = NOW()`,
    BigInt(userId), count, resetAtDayKey
  );
}

describe('daily-submission-counter-reset-worker.processOneTick', () => {
  test('resets the counter when the stored day key is stale (day rolled over)', async () => {
    const userId = await createUser({ tz: 'UTC' });
    await seedStats(userId, { count: 7, resetAtDayKey: '2020-01-01' });

    const res = await DailyReset.processOneTick(prisma, { userIds: [userId], now: new Date() });
    expect(res.candidates).toBe(1);
    expect(res.reset).toBe(1);

    const st = await statsFor(userId);
    expect(st.daily_submission_count).toBe(0);
    const todayKey = toDayKeyString(computeLocalDayKey(new Date(), 'UTC'));
    expect(toDayKeyString(new Date(st.daily_submission_reset_at))).toBe(todayKey);
  });

  test('does NOT reset when the stored day key is already today', async () => {
    const userId = await createUser({ tz: 'UTC' });
    const now = new Date();
    const todayKey = toDayKeyString(computeLocalDayKey(now, 'UTC'));
    await seedStats(userId, { count: 4, resetAtDayKey: todayKey });

    const res = await DailyReset.processOneTick(prisma, { userIds: [userId], now });
    expect(res.reset).toBe(0);
    expect((await statsFor(userId)).daily_submission_count).toBe(4);
  });

  test('a zero counter is never a candidate', async () => {
    const userId = await createUser({ tz: 'UTC' });
    await seedStats(userId, { count: 0, resetAtDayKey: '2020-01-01' });
    const res = await DailyReset.processOneTick(prisma, { userIds: [userId], now: new Date() });
    expect(res.candidates).toBe(0);
    expect(res.reset).toBe(0);
  });

  test('uses the user timezone for the boundary (a non-UTC zone before 5 AM local is still the prior day)', async () => {
    // At 2026-06-15 06:00 UTC, New York local is 02:00 (before the 5 AM reset),
    // so the local day key is 2026-06-14. A counter stamped 2026-06-14 is NOT
    // stale yet and must be preserved.
    const userId = await createUser({ tz: 'America/New_York' });
    const now = new Date(Date.UTC(2026, 5, 15, 6, 0, 0));
    const localKey = toDayKeyString(computeLocalDayKey(now, 'America/New_York'));
    expect(localKey).toBe('2026-06-14'); // sanity on the fixture
    await seedStats(userId, { count: 3, resetAtDayKey: localKey });

    const res = await DailyReset.processOneTick(prisma, { userIds: [userId], now });
    expect(res.reset).toBe(0);
    expect((await statsFor(userId)).daily_submission_count).toBe(3);
  });
});
