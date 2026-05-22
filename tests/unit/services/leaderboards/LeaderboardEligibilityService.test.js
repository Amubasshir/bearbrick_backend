'use strict';

const prisma = require('../../../../src/lib/prisma');
const {
  evaluate,
  loadUserSnapshot,
  isBannedColumnExists,
  _resetColumnCache,
} = require('../../../../src/services/leaderboards/LeaderboardEligibilityService');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createdUserIds = [];

async function createUser(tag = 'elig') {
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
  await prisma.$queryRawUnsafe(
    `INSERT INTO xp_events
       (user_id, xp_amount, xp_delta_signed, reason, event_type,
        source_system, xp_confirmed, local_day_key, "createdAt")
     VALUES ($1, $2, $2, 'VOTE'::"XpReason", 'm3d_test', 'm3d_test', TRUE, $3::date, $4)`,
    userId, amount, localDay, createdAt
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
// Fixture definitions (small in-memory leaderboard-definition stand-ins)
// ---------------------------------------------------------------------------

const WEEKLY_XP_DEF = {
  leaderboardKey: 'weekly_collector_xp',
  scope: 'weekly',
  metricType: 'collector_xp',
  eligibilityRule: {},
};

const LIFETIME_XP_DEF = {
  leaderboardKey: 'lifetime_collector_xp',
  scope: 'lifetime',
  metricType: 'collector_xp',
  eligibilityRule: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LeaderboardEligibilityService.evaluate', () => {
  test('empty rule set → user passes', async () => {
    const userId = await createUser('empty_rules');
    const result = await evaluate(LIFETIME_XP_DEF, userId, 'LIFETIME');
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test('min_level: user below threshold fails', async () => {
    const userId = await createUser('min_level_below');
    await upsertProgressState({ userId, currentLevel: 2 });
    const result = await evaluate(
      { ...LIFETIME_XP_DEF, eligibilityRule: { min_level: 3 } },
      userId, 'LIFETIME'
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('min_level_fail');
  });

  test('min_level: user at threshold passes', async () => {
    const userId = await createUser('min_level_at');
    await upsertProgressState({ userId, currentLevel: 3 });
    const result = await evaluate(
      { ...LIFETIME_XP_DEF, eligibilityRule: { min_level: 3 } },
      userId, 'LIFETIME'
    );
    expect(result.eligible).toBe(true);
  });

  test('min_lifetime_xp: applies correctly', async () => {
    const userId = await createUser('min_xp');
    await upsertProgressState({ userId, totalXpConfirmed: 99 });
    const below = await evaluate(
      { ...LIFETIME_XP_DEF, eligibilityRule: { min_lifetime_xp: 100 } },
      userId, 'LIFETIME'
    );
    expect(below.eligible).toBe(false);
    expect(below.reasons).toContain('min_lifetime_xp_fail');

    await upsertProgressState({ userId, totalXpConfirmed: 100 });
    const at = await evaluate(
      { ...LIFETIME_XP_DEF, eligibilityRule: { min_lifetime_xp: 100 } },
      userId, 'LIFETIME'
    );
    expect(at.eligible).toBe(true);
  });

  test('min_weekly_actions: counts confirmed xp_events in the UTC period', async () => {
    const userId = await createUser('min_weekly_actions');
    const period = '2026-W21';
    // 4 events in the period, 1 outside it.
    await insertConfirmedXpEvent({ userId, amount: 10, createdAt: new Date('2026-05-18T05:00:00Z') });
    await insertConfirmedXpEvent({ userId, amount: 10, createdAt: new Date('2026-05-19T05:00:00Z') });
    await insertConfirmedXpEvent({ userId, amount: 10, createdAt: new Date('2026-05-20T05:00:00Z') });
    await insertConfirmedXpEvent({ userId, amount: 10, createdAt: new Date('2026-05-21T05:00:00Z') });
    await insertConfirmedXpEvent({ userId, amount: 10, createdAt: new Date('2026-05-26T05:00:00Z') }); // next week

    const below = await evaluate(
      { ...WEEKLY_XP_DEF, eligibilityRule: { min_weekly_actions: 5 } },
      userId, period
    );
    expect(below.eligible).toBe(false);
    expect(below.reasons).toContain('min_weekly_actions_fail');

    const at = await evaluate(
      { ...WEEKLY_XP_DEF, eligibilityRule: { min_weekly_actions: 4 } },
      userId, period
    );
    expect(at.eligible).toBe(true);
  });

  test('min_weekly_actions on a lifetime board passes (rule does not apply)', async () => {
    const userId = await createUser('min_weekly_lifetime');
    // User has 0 events, but the rule should pass anyway because scope=lifetime.
    const result = await evaluate(
      { ...LIFETIME_XP_DEF, eligibilityRule: { min_weekly_actions: 5 } },
      userId, 'LIFETIME'
    );
    expect(result.eligible).toBe(true);
  });

  test('min_approved_contributions: stubbed to fail (gates the lifetime contribution board)', async () => {
    const userId = await createUser('contrib_gated');
    const result = await evaluate(
      { ...LIFETIME_XP_DEF, eligibilityRule: { min_approved_contributions: 1 } },
      userId, 'LIFETIME'
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('min_approved_contributions_fail');
  });

  test('unknown rule keys are silently ignored (forward-compatible)', async () => {
    const userId = await createUser('unknown_rule');
    const result = await evaluate(
      { ...LIFETIME_XP_DEF, eligibilityRule: { totally_made_up_rule: 999 } },
      userId, 'LIFETIME'
    );
    expect(result.eligible).toBe(true);
  });

  test('multiple rules combine as AND; reasons lists each failure', async () => {
    const userId = await createUser('multi_fail');
    await upsertProgressState({ userId, totalXpConfirmed: 50, currentLevel: 1 });
    const result = await evaluate(
      {
        ...LIFETIME_XP_DEF,
        eligibilityRule: { min_level: 3, min_lifetime_xp: 100 },
      },
      userId, 'LIFETIME'
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['min_level_fail', 'min_lifetime_xp_fail']));
  });
});

describe('LeaderboardEligibilityService.isBannedColumnExists (graceful absence)', () => {
  test('returns false because the M3d migration does not add is_banned', async () => {
    _resetColumnCache();
    const exists = await isBannedColumnExists();
    expect(exists).toBe(false);
  });

  test('exclude_banned rule passes silently when the column is absent', async () => {
    _resetColumnCache();
    const userId = await createUser('exclude_banned_absent');
    const result = await evaluate(
      { ...LIFETIME_XP_DEF, eligibilityRule: { exclude_banned: true } },
      userId, 'LIFETIME'
    );
    expect(result.eligible).toBe(true);
    expect(result.reasons).not.toContain('exclude_banned_fail');
  });
});

describe('LeaderboardEligibilityService.loadUserSnapshot', () => {
  test('returns zeros when user has no user_progress_state row', async () => {
    const userId = await createUser('snap_empty');
    const snap = await loadUserSnapshot(userId);
    expect(snap.currentLevel).toBe(0);
    expect(snap.totalXpConfirmed).toBe(0);
  });

  test('returns actual state when present', async () => {
    const userId = await createUser('snap_real');
    await upsertProgressState({ userId, totalXpConfirmed: 500, currentLevel: 7 });
    const snap = await loadUserSnapshot(userId);
    expect(snap.currentLevel).toBe(7);
    expect(snap.totalXpConfirmed).toBe(500);
  });
});
