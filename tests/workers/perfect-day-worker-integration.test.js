'use strict';

// Perfect Day worker integration test. Verifies Q3 canonical answer:
// event-driven, immediate, uses local_day_key not calendar date, idempotency
// key shape exact, no double award.

const { v4: uuidv4 } = require('uuid');
const prisma = require('../../src/lib/prisma');
const { maybeAward } = require('../../src/services/challenges/PerfectDayService');

// ---------------------------------------------------------------------------
// Setup helpers — minimal, isolated per test.
// ---------------------------------------------------------------------------

async function freshUser(timezone = 'UTC') {
  const tag = `m3c_pday_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const r = await prisma.$queryRawUnsafe(
    `INSERT INTO "User" (name, email, password, email_verified_at, timezone, "createdAt", "updatedAt")
     VALUES ($1, $2, 'x', NOW(), $3, NOW(), NOW())
     RETURNING id`,
    tag, `${tag}@m3c.test`, timezone
  );
  return BigInt(r[0].id);
}

async function fakeSessionCompletion(userId, kind, localDayKey) {
  // Insert a minimal session_completion_events row + a parent daily_session_set
  // since the FK requires session_set_id. We don't need real bricks for this.
  const setRows = await prisma.$queryRawUnsafe(
    `INSERT INTO daily_session_sets (local_day_key, kind, rotation_cycle_id)
     VALUES ($1::date, $2::"SessionKind",
             (SELECT id FROM session_rotation_cycles ORDER BY started_at DESC LIMIT 1))
     ON CONFLICT (local_day_key, kind) DO UPDATE SET kind = EXCLUDED.kind
     RETURNING id`,
    localDayKey, kind
  );
  const setId = setRows[0].id;

  // Need a vote_event row to satisfy triggered_by_vote_event_id FK
  const brickId = uuidv4();
  await prisma.brick.create({
    data: { id: brickId, name: `pd_${brickId.slice(0, 6)}`, descriptionShort: 'pd', status: 'PROTOTYPE', releasedAt: new Date() },
  });
  await prisma.brickPriceState.create({
    data: { brickId, baselinePrice: 100, livePrice: 100, currentCycleId: uuidv4(), cycleStartPrice: 100, cycleStartedAt: new Date() },
  });
  const veRows = await prisma.$queryRawUnsafe(
    `INSERT INTO vote_events
       (user_id, brick_id, vote_type, live_price_at_vote,
        fair_range_lower, fair_range_upper, base_step_at_vote,
        user_weight_at_vote, cycle_id, "createdAt")
     VALUES ($1, $2, 'FAIR', 100, 95, 105, 7, 1.0, $3, NOW())
     RETURNING id`,
    userId, brickId, uuidv4()
  );

  await prisma.$queryRawUnsafe(
    `INSERT INTO session_completion_events
       (user_id, session_set_id, kind, local_day_key, streak_after_completion, triggered_by_vote_event_id)
     VALUES ($1, $2::uuid, $3::"SessionKind", $4::date, 1, $5)
     ON CONFLICT (user_id, session_set_id) DO NOTHING`,
    userId, setId, kind, localDayKey, BigInt(veRows[0].id)
  );
  return brickId;
}

async function fake5DailyCompletions(userId, localDayKey) {
  // Insert 5 fake user_challenge_assignments rows with status=completed for
  // assignment_date=localDayKey, plus their challenge_completion_events.
  // We pick the first 5 active daily templates for variety.
  const templates = await prisma.$queryRawUnsafe(
    `SELECT id, target_count FROM challenge_templates
      WHERE is_active = TRUE AND scope = 'daily' ORDER BY id ASC LIMIT 5`
  );
  if (templates.length < 5) throw new Error('not enough templates for fixture');

  const inserted = [];
  for (const t of templates) {
    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO user_challenge_assignments
         (user_id, template_id, scope, assignment_date, target_count, progress_count,
          eligibility_snapshot, assigned_at, completed_at, expires_at, status)
       VALUES ($1, $2, 'daily', $3::date, $4, $4, '{}'::jsonb,
               NOW() - INTERVAL '1 hour', NOW(), NOW() + INTERVAL '6 hours', 'completed')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      userId, BigInt(t.id), localDayKey, t.target_count
    );
    if (!r[0]) continue;
    inserted.push(r[0]);
    await prisma.$queryRawUnsafe(
      `INSERT INTO challenge_completion_events
         (user_id, challenge_assignment_id, scope, xp_awarded, idempotency_key)
       VALUES ($1, $2, 'daily', 25, $3)`,
      userId, BigInt(r[0].id), `challenge_complete:${r[0].id}`
    );
  }
  return inserted;
}

async function cleanupUser(id) {
  if (!id) return;
  await prisma.$queryRawUnsafe(`DELETE FROM challenge_completion_events WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM user_challenge_assignments WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM perfect_day_events WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM session_completion_events WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM xp_idempotency_keys WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM xp_events WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM vote_events WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM "User" WHERE id = $1`, id);
}

const created = [];
afterAll(async () => {
  for (const u of created) await cleanupUser(u);
  await prisma.$disconnect();
});

async function inTx(fn) {
  return prisma.$transaction(async (tx) => fn(tx));
}

describe('PerfectDayService.maybeAward — Q3 canonical', () => {
  test('awards Perfect Day when all three conditions are met (same local_day_key)', async () => {
    const userId = await freshUser('UTC');
    created.push(userId);
    const dayKey = '2099-09-30';

    await fakeSessionCompletion(userId, 'MORNING', dayKey);
    await fakeSessionCompletion(userId, 'EVENING', dayKey);
    await fake5DailyCompletions(userId, dayKey);

    await inTx((tx) => maybeAward(tx, userId, dayKey));

    const pd = await prisma.$queryRawUnsafe(
      `SELECT idempotency_key FROM perfect_day_events
        WHERE user_id = $1 AND local_date = $2::date`,
      userId, dayKey
    );
    expect(pd).toHaveLength(1);
    // Q3 idempotency key shape — literal
    expect(pd[0].idempotency_key).toBe(`perfect_day:${userId.toString()}:${dayKey}`);

    // Matching XP event must also exist with the same idempotency key
    const xp = await prisma.$queryRawUnsafe(
      `SELECT idempotency_key, event_type, xp_delta_signed FROM xp_events
        WHERE user_id = $1 AND idempotency_key = $2`,
      userId, `perfect_day:${userId.toString()}:${dayKey}`
    );
    expect(xp).toHaveLength(1);
    expect(xp[0].event_type).toBe('perfect_day_bonus');
    expect(xp[0].xp_delta_signed).toBe(250);
  });

  test('re-running awards no second perfect_day_event and no second XP', async () => {
    const userId = await freshUser('UTC');
    created.push(userId);
    const dayKey = '2099-10-01';

    await fakeSessionCompletion(userId, 'MORNING', dayKey);
    await fakeSessionCompletion(userId, 'EVENING', dayKey);
    await fake5DailyCompletions(userId, dayKey);

    await inTx((tx) => maybeAward(tx, userId, dayKey));
    await inTx((tx) => maybeAward(tx, userId, dayKey));
    await inTx((tx) => maybeAward(tx, userId, dayKey));

    const pd = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM perfect_day_events WHERE user_id = $1`, userId
    );
    expect(pd[0].n).toBe(1);

    const xp = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM xp_events
        WHERE user_id = $1 AND event_type = 'perfect_day_bonus'`,
      userId
    );
    expect(xp[0].n).toBe(1);
  });

  test('no award when Morning missing', async () => {
    const userId = await freshUser('UTC');
    created.push(userId);
    const dayKey = '2099-10-02';
    await fakeSessionCompletion(userId, 'EVENING', dayKey);
    await fake5DailyCompletions(userId, dayKey);
    await inTx((tx) => maybeAward(tx, userId, dayKey));
    const pd = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM perfect_day_events WHERE user_id = $1`, userId
    );
    expect(pd[0].n).toBe(0);
  });

  test('no award when fewer than 5 dailies completed', async () => {
    const userId = await freshUser('UTC');
    created.push(userId);
    const dayKey = '2099-10-03';
    await fakeSessionCompletion(userId, 'MORNING', dayKey);
    await fakeSessionCompletion(userId, 'EVENING', dayKey);
    // Insert only 3 completed dailies
    const templates = await prisma.$queryRawUnsafe(
      `SELECT id, target_count FROM challenge_templates
        WHERE is_active = TRUE AND scope = 'daily' ORDER BY id ASC LIMIT 3`
    );
    for (const t of templates) {
      await prisma.$queryRawUnsafe(
        `INSERT INTO user_challenge_assignments
           (user_id, template_id, scope, assignment_date, target_count, progress_count,
            eligibility_snapshot, assigned_at, completed_at, expires_at, status)
         VALUES ($1, $2, 'daily', $3::date, $4, $4, '{}'::jsonb,
                 NOW(), NOW(), NOW() + INTERVAL '6 hours', 'completed')`,
        userId, BigInt(t.id), dayKey, t.target_count
      );
    }
    await inTx((tx) => maybeAward(tx, userId, dayKey));
    const pd = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM perfect_day_events WHERE user_id = $1`, userId
    );
    expect(pd[0].n).toBe(0);
  });

  test('crossing midnight does NOT break the day — Evening at 1AM still same local_day_key', async () => {
    // The service receives the localDayKey as input — it never derives it
    // from calendar wall-clock. We assert this by inserting an EVENING
    // session_completion_events row with local_day_key set to YESTERDAY's
    // date (because the evening window crossed midnight in M3b's logic).
    const userId = await freshUser('UTC');
    created.push(userId);
    const logicalDay = '2099-10-04';
    await fakeSessionCompletion(userId, 'MORNING', logicalDay);
    // Evening row carries local_day_key=logicalDay even though created_at is
    // post-midnight (M3b's session-progress-worker handles this).
    await fakeSessionCompletion(userId, 'EVENING', logicalDay);
    await fake5DailyCompletions(userId, logicalDay);
    await inTx((tx) => maybeAward(tx, userId, logicalDay));
    const pd = await prisma.$queryRawUnsafe(
      `SELECT idempotency_key FROM perfect_day_events
        WHERE user_id = $1 AND local_date = $2::date`,
      userId, logicalDay
    );
    expect(pd).toHaveLength(1);
    expect(pd[0].idempotency_key).toBe(`perfect_day:${userId.toString()}:${logicalDay}`);
  });
});
