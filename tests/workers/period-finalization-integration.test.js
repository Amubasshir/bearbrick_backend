'use strict';

// Period finalization integration tests. Covers PeriodFinalizationService +
// RewardIssuanceService + InboxService + period-finalization-worker.js.
//
// Strategy: seed leaderboard_state rows directly for a PAST UTC week so the
// finalization path runs deterministically regardless of when the test runs.
// That isolates Phase 4 from Phase 3's worker — we trust that Phase 3 puts
// rows in leaderboard_state, and verify Phase 4 closes the period from there.
//
// Cleanup is per-test to keep failures from cascading. createdUserIds + a
// per-slice DELETE handle the cross-contamination risk in dev DB.

const prisma = require('../../src/lib/prisma');
const {
  processOneTick: workerTick,
} = require('../../src/scripts/period-finalization-worker');
const {
  findDuePeriods,
  finalizePeriod,
  writeAntiSnipingSnapshot,
  buildIdempotencyKey: buildFinalizationKey,
} = require('../../src/services/leaderboards/PeriodFinalizationService');
const RewardIssuanceService = require('../../src/services/leaderboards/RewardIssuanceService');
const {
  utcWeekStartFromKey,
  nextUtcWeekKey,
} = require('../../src/lib/utcWeeks');

// A UTC ISO week that is unambiguously in the past relative to any plausible
// test run date. Period 2026-W18 ends 2026-05-04 00:00:00 UTC.
const PAST_WEEK = '2026-W18';
const PAST_WEEK_END = utcWeekStartFromKey(nextUtcWeekKey(PAST_WEEK));
const LB_XP_WEEKLY = 'weekly_collector_xp';
const LB_CTRB_WEEKLY = 'weekly_contribution_weighted';

const createdUserIds = [];

async function createUser(tag = 'pf') {
  const handle = `m3d_pf_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function upsertStateRow({
  leaderboardKey, periodKey, userId, score, rank, eligible = true,
  tieBreakTimestamp = new Date(), tieBreakEventId = null,
}) {
  await prisma.$queryRawUnsafe(
    `INSERT INTO leaderboard_state
       (leaderboard_key, period_key, user_id, score, eligible, rank,
        tie_break_timestamp, tie_break_event_id, last_updated_at)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, NOW())
     ON CONFLICT (leaderboard_key, period_key, user_id) DO UPDATE
       SET score = EXCLUDED.score, eligible = EXCLUDED.eligible,
           rank = EXCLUDED.rank,
           tie_break_timestamp = EXCLUDED.tie_break_timestamp,
           tie_break_event_id  = EXCLUDED.tie_break_event_id,
           last_updated_at = NOW()`,
    leaderboardKey, periodKey, userId,
    String(score), !!eligible, rank,
    tieBreakTimestamp,
    tieBreakEventId == null ? null : BigInt(tieBreakEventId)
  );
}

async function seedFullPodium(leaderboardKey, periodKey) {
  // 12 users, ranks 1..12. Top_1 = rank 1, Top_3 = ranks 2–3, Top_10 = 4–10.
  // ranks 11 + 12 outside reward window (sanity: no rewards issued there).
  const users = [];
  for (let i = 1; i <= 12; i++) {
    // eslint-disable-next-line no-await-in-loop
    const u = await createUser(`pod${i}_${leaderboardKey.slice(0, 6)}`);
    users.push(u);
    // eslint-disable-next-line no-await-in-loop
    await upsertStateRow({
      leaderboardKey, periodKey, userId: u,
      score: 1000 - i * 10, rank: i, eligible: true,
      tieBreakTimestamp: new Date(`2026-04-${20 + (i % 8)}T12:00:00Z`),
    });
  }
  return users;
}

async function cleanupSlice(leaderboardKey, periodKey) {
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
  await prisma.$queryRawUnsafe(
    `DELETE FROM leaderboard_state
      WHERE leaderboard_key = $1 AND period_key = $2`,
    leaderboardKey, periodKey
  );
  await prisma.$queryRawUnsafe(
    `DELETE FROM leaderboard_reward_events
      WHERE leaderboard_key = $1 AND period_key = $2`,
    leaderboardKey, periodKey
  );
  await prisma.$queryRawUnsafe(
    `UPDATE leaderboard_rewards SET processed_at = NULL
      WHERE leaderboard_key = $1 AND period_key = $2`,
    leaderboardKey, periodKey
  );
}

async function cleanupUsers() {
  for (const id of createdUserIds) {
    await prisma.$queryRawUnsafe(`DELETE FROM inbox_entries WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM user_rewards WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM leaderboard_reward_events WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM leaderboard_state WHERE user_id = $1`, id);
    await prisma.$queryRawUnsafe(`DELETE FROM "User" WHERE id = $1`, id);
  }
  createdUserIds.length = 0;
}

beforeEach(async () => {
  await cleanupSlice(LB_XP_WEEKLY, PAST_WEEK);
  await cleanupSlice(LB_CTRB_WEEKLY, PAST_WEEK);
});
afterEach(async () => {
  await cleanupSlice(LB_XP_WEEKLY, PAST_WEEK);
  await cleanupSlice(LB_CTRB_WEEKLY, PAST_WEEK);
  await cleanupUsers();
});
afterAll(async () => { await prisma.$disconnect(); });

// ---------------------------------------------------------------------------
// findDuePeriods
// ---------------------------------------------------------------------------

describe('findDuePeriods', () => {
  test('returns past period with state rows; excludes current week', async () => {
    const u = await createUser('due_past');
    await upsertStateRow({
      leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u,
      score: 100, rank: 1,
    });

    // Use a nowUtc well after PAST_WEEK_END so the past period is "due"
    // but not so far that another past week we didn't seed is implicated.
    const nowUtc = new Date(PAST_WEEK_END.getTime() + 7 * 86_400_000);
    const due = await findDuePeriods(prisma, nowUtc);

    const matched = due.filter(
      (d) => d.leaderboardKey === LB_XP_WEEKLY && d.periodKey === PAST_WEEK
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].periodEnd.getTime()).toBe(PAST_WEEK_END.getTime());
  });

  test('skips period that is already finalized', async () => {
    const u = await createUser('due_finalized');
    await upsertStateRow({
      leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u,
      score: 100, rank: 1,
    });
    await prisma.$queryRawUnsafe(
      `INSERT INTO leaderboard_period_finalizations
         (leaderboard_key, period_key, total_eligible_users, top_snapshot, idempotency_key)
       VALUES ($1, $2, 1, '[]'::jsonb, $3)`,
      LB_XP_WEEKLY, PAST_WEEK,
      `lb_finalization:${LB_XP_WEEKLY}:${PAST_WEEK}`
    );

    const nowUtc = new Date(PAST_WEEK_END.getTime() + 7 * 86_400_000);
    const due = await findDuePeriods(prisma, nowUtc);
    const matched = due.filter(
      (d) => d.leaderboardKey === LB_XP_WEEKLY && d.periodKey === PAST_WEEK
    );
    expect(matched).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// finalizePeriod — idempotency, snapshot, reward issuance
// ---------------------------------------------------------------------------

describe('finalizePeriod', () => {
  test('writes finalization row with the literal idempotency key shape', async () => {
    const u = await createUser('idem_key');
    await upsertStateRow({
      leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u,
      score: 500, rank: 1,
    });

    const r = await finalizePeriod(prisma, LB_XP_WEEKLY, PAST_WEEK);
    expect(r.finalized).toBe(true);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT idempotency_key FROM leaderboard_period_finalizations
        WHERE leaderboard_key = $1 AND period_key = $2`,
      LB_XP_WEEKLY, PAST_WEEK
    );
    expect(rows).toHaveLength(1);
    // Literal-string assertion per M3c precedent.
    expect(rows[0].idempotency_key).toBe(`lb_finalization:${LB_XP_WEEKLY}:${PAST_WEEK}`);
    expect(rows[0].idempotency_key).toBe(buildFinalizationKey({
      leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK,
    }));
  });

  test('idempotent: running twice yields 1 finalization, 1 set of rewards, 1 inbox per winner', async () => {
    const users = await seedFullPodium(LB_XP_WEEKLY, PAST_WEEK);

    const r1 = await finalizePeriod(prisma, LB_XP_WEEKLY, PAST_WEEK);
    expect(r1.finalized).toBe(true);
    expect(r1.rewardsIssued).toBe(10); // ranks 1..10 all get rewards (1+2+7)

    const r2 = await finalizePeriod(prisma, LB_XP_WEEKLY, PAST_WEEK);
    expect(r2.finalized).toBe(false);
    expect(r2.alreadyFinalized).toBe(true);

    // Exactly one finalization row.
    const finalCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM leaderboard_period_finalizations
        WHERE leaderboard_key = $1 AND period_key = $2`,
      LB_XP_WEEKLY, PAST_WEEK
    );
    expect(finalCount[0].n).toBe(1);

    // Exactly one reward_event per (top10 user × tier) = 10 rows.
    const evtCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM leaderboard_reward_events
        WHERE leaderboard_key = $1 AND period_key = $2`,
      LB_XP_WEEKLY, PAST_WEEK
    );
    expect(evtCount[0].n).toBe(10);

    // Exactly one inbox entry per winner (10 entries total).
    const inboxCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM inbox_entries
        WHERE entry_type = 'leaderboard_reward'
          AND reference_id = $1`,
      `${LB_XP_WEEKLY}:${PAST_WEEK}`
    );
    expect(inboxCount[0].n).toBe(10);

    // Users beyond rank 10 (rank 11, 12) get no rewards.
    for (let i = 10; i < 12; i++) {
      // eslint-disable-next-line no-await-in-loop
      const evts = await prisma.$queryRawUnsafe(
        `SELECT id FROM leaderboard_reward_events
          WHERE user_id = $1 AND leaderboard_key = $2 AND period_key = $3`,
        users[i], LB_XP_WEEKLY, PAST_WEEK
      );
      expect(evts).toHaveLength(0);
    }
  });

  test('tier slicing: rank 1 → top_1, ranks 2–3 → top_3, ranks 4–10 → top_10', async () => {
    const users = await seedFullPodium(LB_XP_WEEKLY, PAST_WEEK);
    await finalizePeriod(prisma, LB_XP_WEEKLY, PAST_WEEK);

    const placementsByUser = new Map();
    const rows = await prisma.$queryRawUnsafe(
      `SELECT user_id, placement_tier FROM leaderboard_reward_events
        WHERE leaderboard_key = $1 AND period_key = $2`,
      LB_XP_WEEKLY, PAST_WEEK
    );
    for (const r of rows) {
      placementsByUser.set(String(r.user_id), r.placement_tier);
    }
    expect(placementsByUser.get(String(users[0]))).toBe('top_1');
    expect(placementsByUser.get(String(users[1]))).toBe('top_3');
    expect(placementsByUser.get(String(users[2]))).toBe('top_3');
    for (let i = 3; i < 10; i++) {
      expect(placementsByUser.get(String(users[i]))).toBe('top_10');
    }
  });

  test('user_rewards uniqueness: re-finalize creates no duplicate user_rewards', async () => {
    const users = await seedFullPodium(LB_XP_WEEKLY, PAST_WEEK);
    await finalizePeriod(prisma, LB_XP_WEEKLY, PAST_WEEK);

    // Top_1 reward bundle has 4 entries (calling_card + badge + title + flourish).
    const before = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM user_rewards
        WHERE user_id = $1 AND source_type = 'leaderboard'::"RewardSource"
          AND source_id = $2`,
      users[0], PAST_WEEK
    );
    expect(before[0].n).toBe(4);

    // Second call (worker tick re-runs) — also a no-op for user_rewards.
    // We can't call finalizePeriod twice (it short-circuits); reissue directly
    // through RewardIssuanceService and check the count is still 4.
    const r = await RewardIssuanceService.issue(prisma, {
      userId: users[0],
      leaderboardKey: LB_XP_WEEKLY,
      periodKey: PAST_WEEK,
      placementTier: 'top_1',
      rewardBundle: [
        { reward_type: 'calling_card', reward_slug: 'cc_weekly_xp_champion' },
        { reward_type: 'badge',        reward_slug: 'bd_weekly_xp_top_1' },
        { reward_type: 'title',        reward_slug: 'ti_xp_champion' },
        { reward_type: 'flourish',     reward_slug: 'fl_gold_sparkle' },
      ],
    });
    expect(r.issued).toBe(false);
    expect(r.reason).toBe('already_issued');

    const after = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM user_rewards
        WHERE user_id = $1 AND source_type = 'leaderboard'::"RewardSource"
          AND source_id = $2`,
      users[0], PAST_WEEK
    );
    expect(after[0].n).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Reward issuance — idempotency key shape, inbox entry, bundle freezing
// ---------------------------------------------------------------------------

describe('RewardIssuanceService.issue', () => {
  test('writes reward_event with literal idempotency key shape', async () => {
    const u = await createUser('rwd_key');
    await upsertStateRow({
      leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u,
      score: 999, rank: 1,
    });

    const result = await RewardIssuanceService.issue(prisma, {
      userId: u,
      leaderboardKey: LB_XP_WEEKLY,
      periodKey: PAST_WEEK,
      placementTier: 'top_1',
      rewardBundle: [
        { reward_type: 'calling_card', reward_slug: 'cc_weekly_xp_champion' },
      ],
    });
    expect(result.issued).toBe(true);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT idempotency_key FROM leaderboard_reward_events
        WHERE user_id = $1 AND leaderboard_key = $2 AND period_key = $3
          AND placement_tier = 'top_1'`,
      u, LB_XP_WEEKLY, PAST_WEEK
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe(
      `lb_reward:${LB_XP_WEEKLY}:${PAST_WEEK}:${u}:top_1`
    );
    expect(rows[0].idempotency_key).toBe(
      RewardIssuanceService.buildIdempotencyKey({
        leaderboardKey: LB_XP_WEEKLY,
        periodKey: PAST_WEEK,
        userId: u,
        placementTier: 'top_1',
      })
    );
  });

  test('issuance creates exactly one inbox_entry per reward_event', async () => {
    const u = await createUser('rwd_inbox');
    await upsertStateRow({
      leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u,
      score: 500, rank: 1,
    });

    const r1 = await RewardIssuanceService.issue(prisma, {
      userId: u,
      leaderboardKey: LB_XP_WEEKLY,
      periodKey: PAST_WEEK,
      placementTier: 'top_1',
      rewardBundle: [{ reward_type: 'badge', reward_slug: 'bd_weekly_xp_top_1' }],
    });
    expect(r1.issued).toBe(true);

    const r2 = await RewardIssuanceService.issue(prisma, {
      userId: u,
      leaderboardKey: LB_XP_WEEKLY,
      periodKey: PAST_WEEK,
      placementTier: 'top_1',
      rewardBundle: [{ reward_type: 'badge', reward_slug: 'bd_weekly_xp_top_1' }],
    });
    expect(r2.issued).toBe(false);

    const inboxRows = await prisma.$queryRawUnsafe(
      `SELECT id, entry_type, metadata, is_read FROM inbox_entries
        WHERE user_id = $1 AND reference_id = $2`,
      u, `${LB_XP_WEEKLY}:${PAST_WEEK}`
    );
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].entry_type).toBe('leaderboard_reward');
    expect(inboxRows[0].is_read).toBe(false);
    expect(inboxRows[0].metadata.leaderboard_key).toBe(LB_XP_WEEKLY);
    expect(inboxRows[0].metadata.placement_tier).toBe('top_1');
  });

  test('reward bundle snapshot is frozen — later edits to leaderboard_rewards do not mutate history', async () => {
    const u = await createUser('rwd_frozen');
    const originalBundle = [
      { reward_type: 'badge', reward_slug: 'bd_weekly_xp_top_1' },
    ];

    await RewardIssuanceService.issue(prisma, {
      userId: u,
      leaderboardKey: LB_XP_WEEKLY,
      periodKey: PAST_WEEK,
      placementTier: 'top_1',
      rewardBundle: originalBundle,
    });

    // Mutate the live leaderboard_rewards row to a different bundle.
    const mutatedBundle = [
      { reward_type: 'title', reward_slug: 'ti_xp_champion' },
    ];
    await prisma.$queryRawUnsafe(
      `UPDATE leaderboard_rewards
          SET reward_bundle = $1::jsonb
        WHERE leaderboard_key = $2 AND period_key = '*' AND placement_tier = 'top_1'`,
      JSON.stringify(mutatedBundle), LB_XP_WEEKLY
    );

    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT reward_bundle_snapshot FROM leaderboard_reward_events
          WHERE user_id = $1 AND leaderboard_key = $2 AND period_key = $3
            AND placement_tier = 'top_1'`,
        u, LB_XP_WEEKLY, PAST_WEEK
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].reward_bundle_snapshot).toEqual(originalBundle);
    } finally {
      // Restore the seed bundle so other tests / runs see the canonical state.
      await prisma.$queryRawUnsafe(
        `UPDATE leaderboard_rewards
            SET reward_bundle = $1::jsonb
          WHERE leaderboard_key = $2 AND period_key = '*' AND placement_tier = 'top_1'`,
        JSON.stringify([
          { reward_type: 'calling_card', reward_slug: 'cc_weekly_xp_champion' },
          { reward_type: 'badge',        reward_slug: 'bd_weekly_xp_top_1' },
          { reward_type: 'title',        reward_slug: 'ti_xp_champion' },
          { reward_type: 'flourish',     reward_slug: 'fl_gold_sparkle' },
        ]), LB_XP_WEEKLY
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Anti-sniping snapshot
// ---------------------------------------------------------------------------

describe('writeAntiSnipingSnapshot', () => {
  test('snapshot is written when nowUtc lands inside the window, then idempotent', async () => {
    const u = await createUser('snap_in');
    await upsertStateRow({
      leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u,
      score: 800, rank: 1,
    });
    // nowUtc inside the window: 150s before period_end (window is 300s).
    const insideWindow = new Date(PAST_WEEK_END.getTime() - 150_000);

    const r1 = await writeAntiSnipingSnapshot(prisma, LB_XP_WEEKLY, PAST_WEEK, insideWindow);
    expect(r1.written).toBe(true);
    expect(r1.topSnapshotSize).toBeGreaterThanOrEqual(1);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT top_snapshot FROM leaderboard_visibility_snapshots
        WHERE leaderboard_key = $1 AND period_key = $2`,
      LB_XP_WEEKLY, PAST_WEEK
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].top_snapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({ rank: 1, user_id: String(u) }),
    ]));

    // Second call within the window: no duplicate.
    const r2 = await writeAntiSnipingSnapshot(prisma, LB_XP_WEEKLY, PAST_WEEK, insideWindow);
    expect(r2.written).toBe(false);
    expect(r2.reason).toBe('already_snapshotted');
  });

  test('snapshot is NOT written before window opens or after period_end', async () => {
    const u = await createUser('snap_skip');
    await upsertStateRow({
      leaderboardKey: LB_XP_WEEKLY, periodKey: PAST_WEEK, userId: u,
      score: 800, rank: 1,
    });

    // Way before window — 1 hour before period_end (window is 300s = 5 min).
    const beforeWindow = new Date(PAST_WEEK_END.getTime() - 3600_000);
    const rBefore = await writeAntiSnipingSnapshot(prisma, LB_XP_WEEKLY, PAST_WEEK, beforeWindow);
    expect(rBefore.written).toBe(false);
    expect(rBefore.reason).toBe('before_window');

    // After period_end — should not write either.
    const afterPeriod = new Date(PAST_WEEK_END.getTime() + 60_000);
    const rAfter = await writeAntiSnipingSnapshot(prisma, LB_XP_WEEKLY, PAST_WEEK, afterPeriod);
    expect(rAfter.written).toBe(false);
    expect(rAfter.reason).toBe('after_period');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM leaderboard_visibility_snapshots
        WHERE leaderboard_key = $1 AND period_key = $2`,
      LB_XP_WEEKLY, PAST_WEEK
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Worker tick — orchestrates both snapshots and finalizations
// ---------------------------------------------------------------------------

describe('period-finalization-worker.processOneTick', () => {
  test('finalizes due past period and issues rewards in one tick', async () => {
    const users = await seedFullPodium(LB_XP_WEEKLY, PAST_WEEK);
    const nowUtc = new Date(PAST_WEEK_END.getTime() + 7 * 86_400_000);

    const result = await workerTick(prisma, { nowUtc });

    const finalized = result.finalizations.find(
      (f) => f.leaderboardKey === LB_XP_WEEKLY && f.periodKey === PAST_WEEK
    );
    expect(finalized).toBeDefined();
    expect(finalized.finalized).toBe(true);
    expect(finalized.rewardsIssued).toBe(10);

    // Rank-1 winner has the full top_1 bundle (4 cosmetics).
    const userRewards = await prisma.$queryRawUnsafe(
      `SELECT reward_type FROM user_rewards
        WHERE user_id = $1 AND source_type = 'leaderboard'::"RewardSource"
          AND source_id = $2
        ORDER BY reward_type ASC`,
      users[0], PAST_WEEK
    );
    expect(userRewards.map((r) => r.reward_type).sort()).toEqual(
      ['badge', 'calling_card', 'flourish', 'title']
    );
  });
});
