'use strict';

const request = require('supertest');
const app = require('../../src/app');
const prisma = require('../../src/lib/prisma');
const { createFreshUser } = require('../helpers/dex');

const LB_XP_WEEKLY = 'weekly_collector_xp';
const LB_XP_LIFETIME = 'lifetime_collector_xp';
const PAST_WEEK = '2026-W17';

const createdUserIds = [];

async function upsertStateRow({
  leaderboardKey, periodKey, userId, score, rank,
  eligible = true, tieBreakTimestamp = new Date('2026-04-15T12:00:00Z'),
}) {
  await prisma.$queryRawUnsafe(
    `INSERT INTO leaderboard_state
       (leaderboard_key, period_key, user_id, score, eligible, rank,
        tie_break_timestamp, last_updated_at)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, NOW())
     ON CONFLICT (leaderboard_key, period_key, user_id) DO UPDATE
       SET score = EXCLUDED.score, eligible = EXCLUDED.eligible,
           rank = EXCLUDED.rank,
           tie_break_timestamp = EXCLUDED.tie_break_timestamp,
           last_updated_at = NOW()`,
    leaderboardKey, periodKey, BigInt(userId),
    String(score), !!eligible, rank, tieBreakTimestamp
  );
}

async function cleanupSlice(leaderboardKey, periodKey) {
  await prisma.$queryRawUnsafe(
    `DELETE FROM leaderboard_state
      WHERE leaderboard_key = $1 AND period_key = $2`,
    leaderboardKey, periodKey
  );
  await prisma.$queryRawUnsafe(
    `DELETE FROM leaderboard_period_finalizations
      WHERE leaderboard_key = $1 AND period_key = $2`,
    leaderboardKey, periodKey
  );
  await prisma.$queryRawUnsafe(
    `DELETE FROM leaderboard_visibility_snapshots
      WHERE leaderboard_key = $1 AND period_key = $2`,
    leaderboardKey, periodKey
  );
}

beforeEach(async () => {
  await cleanupSlice(LB_XP_WEEKLY, PAST_WEEK);
});
afterEach(async () => {
  await cleanupSlice(LB_XP_WEEKLY, PAST_WEEK);
  // Lifetime rows get cleaned up per-user below.
});
afterAll(async () => {
  for (const id of createdUserIds) {
    await prisma.$queryRawUnsafe(
      `DELETE FROM leaderboard_state WHERE user_id = $1`, BigInt(id)
    );
    // User rows are NOT deleted — same pattern as other M3a/M3b/M3c API tests.
    // The user_identity_state FK + dozens of cross-table FKs make blanket
    // User deletion unsafe across runs; tests rely on unique emails per run.
  }
  await prisma.$disconnect();
});

describe('GET /api/leaderboards/:key', () => {
  test('404 when leaderboard key is unknown', async () => {
    const res = await request(app)
      .get('/api/leaderboards/does_not_exist?tab=top100');
    expect(res.status).toBe(404);
  });

  test('400 when tab is missing or invalid', async () => {
    const r1 = await request(app)
      .get(`/api/leaderboards/${LB_XP_WEEKLY}`);
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .get(`/api/leaderboards/${LB_XP_WEEKLY}?tab=garbage`);
    expect(r2.status).toBe(400);
  });

  test('200 + top100 rows for guest (user_row=null)', async () => {
    // Seed 3 ranked users on the past week.
    const u1 = await createFreshUser('lb-g1');
    const u2 = await createFreshUser('lb-g2');
    const u3 = await createFreshUser('lb-g3');
    createdUserIds.push(u1.userId, u2.userId, u3.userId);
    await upsertStateRow({ leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u1.userId, score: 900, rank: 1 });
    await upsertStateRow({ leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u2.userId, score: 500, rank: 2 });
    await upsertStateRow({ leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u3.userId, score: 100, rank: 3 });

    const res = await request(app)
      .get(`/api/leaderboards/${LB_XP_WEEKLY}?tab=top100&period_key=${PAST_WEEK}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.leaderboard_key).toBe(LB_XP_WEEKLY);
    expect(res.body.data.period_key).toBe(PAST_WEEK);
    expect(res.body.data.scope).toBe('weekly');
    expect(res.body.data.tab).toBe('top100');
    expect(res.body.data.user_row).toBeNull();
    expect(res.body.data.source).toBe('live');
    expect(res.body.data.anti_sniping_active).toBe(false);
    expect(res.body.data.rows).toEqual([
      expect.objectContaining({ rank: 1, user_id: String(u1.userId), score: 900 }),
      expect.objectContaining({ rank: 2, user_id: String(u2.userId), score: 500 }),
      expect.objectContaining({ rank: 3, user_id: String(u3.userId), score: 100 }),
    ]);
    expect(Array.isArray(res.body.data.reward_tier_preview)).toBe(true);
    expect(res.body.data.reward_tier_preview[0].tier).toBe('top_1');
    expect(res.body.data.reset_at).toMatch(/T\d\d:\d\d:\d\d/);
  });

  test('200 + user_row populated for authed viewer', async () => {
    const me = await createFreshUser('lb-me');
    const other = await createFreshUser('lb-other');
    createdUserIds.push(me.userId, other.userId);
    await upsertStateRow({ leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: other.userId, score: 900, rank: 1 });
    await upsertStateRow({ leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: me.userId, score: 200, rank: 2 });

    const res = await request(app)
      .get(`/api/leaderboards/${LB_XP_WEEKLY}?tab=top100&period_key=${PAST_WEEK}`)
      .set('Authorization', `Bearer ${me.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user_row).toEqual(expect.objectContaining({
      rank: 2, user_id: String(me.userId), score: 200, eligible: true,
    }));
  });

  test('tab=around-me returns viewer ± window slice', async () => {
    // Seed 20 ranked users; viewer is rank 10. Window default = 5.
    const seeds = [];
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      const u = await createFreshUser(`lb-am-${i}`);
      createdUserIds.push(u.userId);
      seeds.push(u);
    }
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await upsertStateRow({
        leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK,
        userId: seeds[i].userId, score: 1000 - i, rank: i + 1,
      });
    }
    const viewer = seeds[9]; // rank 10

    const res = await request(app)
      .get(`/api/leaderboards/${LB_XP_WEEKLY}?tab=around-me&period_key=${PAST_WEEK}`)
      .set('Authorization', `Bearer ${viewer.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((r) => r.rank)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  test('400 on malformed period_key', async () => {
    const res = await request(app)
      .get(`/api/leaderboards/${LB_XP_WEEKLY}?tab=top100&period_key=not-a-week`);
    expect(res.status).toBe(400);
  });

  test('lifetime board coerces period_key to LIFETIME and has null reset_at', async () => {
    const u = await createFreshUser('lb-life');
    createdUserIds.push(u.userId);
    await upsertStateRow({
      leaderboardKey: LB_XP_LIFETIME, periodKey: 'LIFETIME',
      userId: u.userId, score: 750, rank: 1,
    });

    const res = await request(app)
      .get(`/api/leaderboards/${LB_XP_LIFETIME}?tab=top100`);
    expect(res.status).toBe(200);
    expect(res.body.data.period_key).toBe('LIFETIME');
    expect(res.body.data.scope).toBe('lifetime');
    expect(res.body.data.reset_at).toBeNull();
    // Lifetime board has reward_enabled=false → no preview.
    expect(res.body.data.reward_tier_preview).toEqual([]);
  });

  test('finalized period serves finalized_snapshot source', async () => {
    const u = await createFreshUser('lb-fin');
    createdUserIds.push(u.userId);

    // Seed state + finalization row with frozen snapshot.
    await upsertStateRow({
      leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK,
      userId: u.userId, score: 800, rank: 1,
    });
    const frozenSnapshot = [{
      rank: 1, user_id: String(u.userId), score: 800,
      tie_break_timestamp: '2026-04-15T12:00:00.000Z', tie_break_event_id: null,
    }];
    await prisma.$queryRawUnsafe(
      `INSERT INTO leaderboard_period_finalizations
         (leaderboard_key, period_key, total_eligible_users, top_snapshot, idempotency_key)
       VALUES ($1, $2, 1, $3::jsonb, $4)`,
      LB_XP_WEEKLY, PAST_WEEK, JSON.stringify(frozenSnapshot),
      `lb_finalization:${LB_XP_WEEKLY}:${PAST_WEEK}`
    );

    const res = await request(app)
      .get(`/api/leaderboards/${LB_XP_WEEKLY}?tab=top100&period_key=${PAST_WEEK}`);
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('finalized_snapshot');
    expect(res.body.data.rows).toEqual([
      expect.objectContaining({ rank: 1, user_id: String(u.userId), score: 800 }),
    ]);
  });
});
