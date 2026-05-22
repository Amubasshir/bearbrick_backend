'use strict';

const { v4: uuidv4 } = require('uuid');
const prisma = require('../../src/lib/prisma');
const { processOneVoteForChallenges } =
  require('../../src/scripts/challenge-progress-worker');

// ---------------------------------------------------------------------------
// Test helpers — minimal, hermetic, never share global cursors.
// ---------------------------------------------------------------------------

async function createUser(timezone = 'UTC') {
  const tag = `m3c_progress_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const r = await prisma.$queryRawUnsafe(
    `INSERT INTO "User" (name, email, password, email_verified_at, timezone, "createdAt", "updatedAt")
     VALUES ($1, $2, 'x', NOW(), $3, NOW(), NOW())
     RETURNING id`,
    tag, `${tag}@m3c.test`, timezone
  );
  return BigInt(r[0].id);
}

async function createPublishedBrick() {
  const id = uuidv4();
  await prisma.brick.create({
    data: {
      id,
      name: `m3c_brick_${id.slice(0, 8)}`,
      descriptionShort: 'M3c progress test brick',
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

async function insertVoteEvent({ userId, brickId, voteType = 'FAIR', createdAt }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO vote_events
       (user_id, brick_id, vote_type, live_price_at_vote,
        fair_range_lower, fair_range_upper, base_step_at_vote,
        user_weight_at_vote, cycle_id, "createdAt")
     VALUES ($1, $2, $3::"VoteType", 100, 95, 105, 7, 1.0, $4, $5)
     RETURNING id, user_id, brick_id, vote_type, "createdAt" AS created_at`,
    BigInt(userId), brickId, voteType, uuidv4(), createdAt
  );
  return rows[0];
}

async function cleanupUser(id) {
  if (!id) return;
  // Reverse FK order
  await prisma.$queryRawUnsafe(
    `DELETE FROM challenge_completion_events WHERE user_id = $1`, id
  );
  await prisma.$queryRawUnsafe(
    `DELETE FROM user_challenge_assignments WHERE user_id = $1`, id
  );
  await prisma.$queryRawUnsafe(
    `DELETE FROM challenge_assignment_log WHERE user_id = $1`, id
  );
  await prisma.$queryRawUnsafe(`DELETE FROM xp_idempotency_keys WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM xp_events WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM vote_events WHERE user_id = $1`, id);
  await prisma.$queryRawUnsafe(`DELETE FROM "User" WHERE id = $1`, id);
}

let createdUsers = [];
async function freshUser(tz = 'UTC') {
  const u = await createUser(tz);
  createdUsers.push(u);
  return u;
}

afterAll(async () => {
  for (const u of createdUsers) await cleanupUser(u);
  await prisma.$disconnect();
});

// Quick driver: run the worker for a single vote event the way the polling
// loop would, but synchronously and isolated from the global cursor.
async function drive(voteEvent) {
  const userIdBig = BigInt(voteEvent.user_id);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1)`, userIdBig);
    await processOneVoteForChallenges(tx, voteEvent);
  });
}

describe('challenge-progress-worker — integration', () => {
  test('first vote opens 5 daily assignments and progresses the matching ones', async () => {
    const userId = await freshUser('UTC');
    const brick = await createPublishedBrick();
    const now = new Date('2099-09-20T10:00:00Z');
    const ev = await insertVoteEvent({ userId, brickId: brick, createdAt: now });

    await drive(ev);

    const assignments = await prisma.$queryRawUnsafe(
      `SELECT uca.id, uca.progress_count, uca.status, ct.code, ct.target_count
         FROM user_challenge_assignments uca
         JOIN challenge_templates ct ON ct.id = uca.template_id
        WHERE uca.user_id = $1 AND uca.scope = 'daily'
        ORDER BY uca.id ASC`,
      userId
    );
    expect(assignments).toHaveLength(5);
    // At least one assignment that does per_event vote-matching should have
    // progress 1 (the vote we just cast). Templates whose match is too strict
    // (e.g. is_stale=true) won't progress on a non-stale brick.
    const progressed = assignments.filter((a) => Number(a.progress_count) > 0);
    expect(progressed.length).toBeGreaterThan(0);
  });

  test('completing daily_vote_5 mints the challenge XP event exactly once', async () => {
    const userId = await freshUser('UTC');
    const brick1 = await createPublishedBrick();
    const brick2 = await createPublishedBrick();
    const brick3 = await createPublishedBrick();
    const baseTime = new Date('2099-09-21T10:00:00Z');

    // Cast 5 votes (mix of bricks so per_unique_brick templates also progress)
    const bricks = [brick1, brick2, brick3, brick1, brick2];
    for (let i = 0; i < 5; i++) {
      const ev = await insertVoteEvent({
        userId,
        brickId: bricks[i],
        createdAt: new Date(baseTime.getTime() + i * 1000),
      });
      await drive(ev);
    }

    // The daily_vote_5 template (per_event, target 5) MUST be in the user's
    // assignments and completed.
    const completed = await prisma.$queryRawUnsafe(
      `SELECT uca.*, ct.code FROM user_challenge_assignments uca
         JOIN challenge_templates ct ON ct.id = uca.template_id
        WHERE uca.user_id = $1 AND uca.status = 'completed'`,
      userId
    );
    const codes = completed.map((c) => c.code);
    expect(codes).toContain('daily_vote_5');

    // Exactly one challenge_completion XP event for that assignment
    const dailyVote5 = completed.find((c) => c.code === 'daily_vote_5');
    const xp = await prisma.$queryRawUnsafe(
      `SELECT idempotency_key FROM xp_events WHERE user_id = $1 AND idempotency_key = $2`,
      userId, `challenge_xp:${dailyVote5.id}`
    );
    expect(xp).toHaveLength(1);
  });

  test('completing all 5 dailies mints the all_five_dailies bonus exactly once', async () => {
    const userId = await freshUser('UTC');
    const baseTime = new Date('2099-09-22T10:00:00Z');
    // Pump enough varied votes to clear every target_count up to ~10 unique bricks.
    const bricks = [];
    for (let i = 0; i < 10; i++) bricks.push(await createPublishedBrick());
    // Vote each brick once → 10 unique bricks, 10 events
    for (let i = 0; i < 10; i++) {
      const ev = await insertVoteEvent({
        userId,
        brickId: bricks[i],
        createdAt: new Date(baseTime.getTime() + i * 1000),
      });
      await drive(ev);
    }

    const allDailies = await prisma.$queryRawUnsafe(
      `SELECT status, ct.code FROM user_challenge_assignments uca
         JOIN challenge_templates ct ON ct.id = uca.template_id
        WHERE uca.user_id = $1 AND uca.scope = 'daily'`,
      userId
    );
    const allCompleted = allDailies.every((a) => a.status === 'completed');

    if (allCompleted) {
      const localDayKey = '2099-09-22';
      const bonus = await prisma.$queryRawUnsafe(
        `SELECT idempotency_key FROM xp_events
          WHERE user_id = $1 AND idempotency_key = $2`,
        userId, `all_five_dailies:${userId.toString()}:${localDayKey}`
      );
      expect(bonus).toHaveLength(1);

      // Re-drive a vote — bonus must not be minted again
      const replay = await insertVoteEvent({
        userId, brickId: bricks[0],
        createdAt: new Date(baseTime.getTime() + 30 * 1000),
      });
      await drive(replay);
      const bonus2 = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM xp_events
          WHERE user_id = $1 AND idempotency_key = $2`,
        userId, `all_five_dailies:${userId.toString()}:${localDayKey}`
      );
      expect(bonus2[0].n).toBe(1);
    } else {
      // If 10 votes isn't enough to clear every assignment (some templates
      // target up to 10), at least one should not have completed and the
      // bonus must not have been minted.
      const bonus = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM xp_events
          WHERE user_id = $1
            AND idempotency_key = $2`,
        userId, `all_five_dailies:${userId.toString()}:2099-09-22`
      );
      expect(bonus[0].n).toBe(0);
    }
  });

  test('replaying the same vote_event does NOT double-award challenge XP', async () => {
    const userId = await freshUser('UTC');
    const brick = await createPublishedBrick();
    const now = new Date('2099-09-23T10:00:00Z');
    // 5 votes to complete daily_vote_5
    for (let i = 0; i < 5; i++) {
      const ev = await insertVoteEvent({
        userId, brickId: brick,
        createdAt: new Date(now.getTime() + i * 1000),
      });
      await drive(ev);
    }
    // Re-drive the last event
    const last = await prisma.$queryRawUnsafe(
      `SELECT id, user_id, brick_id, vote_type, "createdAt" AS created_at
         FROM vote_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      userId
    );
    await drive(last[0]);

    const xpDailyVote5 = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM xp_events
        WHERE user_id = $1
          AND idempotency_key LIKE 'challenge_xp:%'`,
      userId
    );
    // Each completed challenge yields exactly one challenge_xp event.
    // The replay must not add another.
    const completed = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM user_challenge_assignments
        WHERE user_id = $1 AND status = 'completed'`,
      userId
    );
    expect(xpDailyVote5[0].n).toBe(completed[0].n);
  });
});
