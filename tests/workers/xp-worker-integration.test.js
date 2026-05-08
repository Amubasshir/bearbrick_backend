'use strict';

const prisma = require('../../src/lib/prisma');
const { createFreshUser } = require('../helpers/dex');
const { processUser } = require('../../src/scripts/xp-reconciliation-worker');

let levelDefs;

async function insertXpEvent({ userId, xpDeltaSigned, xpConfirmed = true, idempotencyKey = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO xp_events
       (user_id, xp_amount, xp_delta_signed, reason, event_type, source_system,
        xp_confirmed, local_day_key, idempotency_key, "createdAt")
     VALUES ($1, $2, $3, 'VOTE'::"XpReason", 'vote_cast', 'test',
             $4, CURRENT_DATE, $5, NOW())
     RETURNING id`,
    BigInt(userId),
    Math.abs(xpDeltaSigned),
    xpDeltaSigned,
    xpConfirmed,
    idempotencyKey
  );
  return rows[0].id;
}

async function getProgressState(userId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM user_progress_state WHERE user_id = $1`,
    BigInt(userId)
  );
  return rows[0] ?? null;
}

async function getLevelUpEvents(userId) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM level_up_events WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
    BigInt(userId)
  );
}

beforeAll(async () => {
  levelDefs = await prisma.$queryRaw`
    SELECT level_number, min_xp, is_active
    FROM level_definitions
    WHERE is_active = TRUE
    ORDER BY level_number ASC
  `;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Basic processing
// ---------------------------------------------------------------------------
describe('Worker — basic processing', () => {
  test('creates user_progress_state row for user who has none yet', async () => {
    const { userId } = await createFreshUser('basic1');
    await insertXpEvent({ userId, xpDeltaSigned: 10 });
    await processUser(BigInt(userId), prisma, levelDefs);
    const state = await getProgressState(userId);
    expect(state).not.toBeNull();
  });

  test('sets total_xp_confirmed = sum of all confirmed xp_delta_signed values', async () => {
    const { userId } = await createFreshUser('basic2');
    await insertXpEvent({ userId, xpDeltaSigned: 10 });
    await insertXpEvent({ userId, xpDeltaSigned: 20 });
    await processUser(BigInt(userId), prisma, levelDefs);
    const state = await getProgressState(userId);
    expect(Number(state.total_xp_confirmed)).toBe(30);
  });

  test('sets last_reconciled_xp_event_id = max(id) of processed events', async () => {
    const { userId } = await createFreshUser('basic3');
    await insertXpEvent({ userId, xpDeltaSigned: 10 });
    const id2 = await insertXpEvent({ userId, xpDeltaSigned: 10 });
    await processUser(BigInt(userId), prisma, levelDefs);
    const state = await getProgressState(userId);
    expect(BigInt(state.last_reconciled_xp_event_id)).toBe(BigInt(id2));
  });

  test('does NOT include xp_confirmed = false events in total', async () => {
    const { userId } = await createFreshUser('basic4');
    await insertXpEvent({ userId, xpDeltaSigned: 50 });
    await insertXpEvent({ userId, xpDeltaSigned: 999, xpConfirmed: false });
    await processUser(BigInt(userId), prisma, levelDefs);
    const state = await getProgressState(userId);
    expect(Number(state.total_xp_confirmed)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Level-up events
// ---------------------------------------------------------------------------
describe('Worker — level-up events', () => {
  test('inserts level_up_events row when user crosses level threshold', async () => {
    const { userId } = await createFreshUser('lvl1');
    await insertXpEvent({ userId, xpDeltaSigned: 100 }); // crosses level 2 threshold
    await processUser(BigInt(userId), prisma, levelDefs);
    const events = await getLevelUpEvents(userId);
    expect(events.length).toBe(1);
  });

  test('level_up_event has correct from_level, to_level, triggered_by_xp_event_id', async () => {
    const { userId } = await createFreshUser('lvl2');
    const eventId = await insertXpEvent({ userId, xpDeltaSigned: 100 });
    await processUser(BigInt(userId), prisma, levelDefs);
    const [ev] = await getLevelUpEvents(userId);
    expect(Number(ev.from_level)).toBe(1);
    expect(Number(ev.to_level)).toBe(2);
    expect(BigInt(ev.triggered_by_xp_event_id)).toBe(BigInt(eventId));
  });

  test('does NOT insert level_up_events when XP stays within same level', async () => {
    const { userId } = await createFreshUser('lvl3');
    await insertXpEvent({ userId, xpDeltaSigned: 50 }); // stays at level 1
    await processUser(BigInt(userId), prisma, levelDefs);
    const events = await getLevelUpEvents(userId);
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No level downgrade
// ---------------------------------------------------------------------------
describe('Worker — no level downgrade', () => {
  test('after positive delta (level 1→2), negative delta does not reduce current_level', async () => {
    const { userId } = await createFreshUser('nodown1');
    await insertXpEvent({ userId, xpDeltaSigned: 100 }); // → level 2
    await processUser(BigInt(userId), prisma, levelDefs);
    await insertXpEvent({ userId, xpDeltaSigned: -100 }); // drops XP total to 0
    await processUser(BigInt(userId), prisma, levelDefs);
    const state = await getProgressState(userId);
    expect(Number(state.current_level)).toBe(2);
  });

  test('highest_level_ever stays at 2 even after XP total drops below level 2 min_xp', async () => {
    const { userId } = await createFreshUser('nodown2');
    await insertXpEvent({ userId, xpDeltaSigned: 100 }); // → level 2
    await processUser(BigInt(userId), prisma, levelDefs);
    await insertXpEvent({ userId, xpDeltaSigned: -100 });
    await processUser(BigInt(userId), prisma, levelDefs);
    const state = await getProgressState(userId);
    expect(Number(state.highest_level_ever)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------
describe('Worker — idempotency', () => {
  test('running worker twice on same user produces identical user_progress_state', async () => {
    const { userId } = await createFreshUser('idem1');
    await insertXpEvent({ userId, xpDeltaSigned: 50 });
    await processUser(BigInt(userId), prisma, levelDefs);
    const state1 = await getProgressState(userId);
    await processUser(BigInt(userId), prisma, levelDefs);
    const state2 = await getProgressState(userId);
    expect(Number(state2.total_xp_confirmed)).toBe(Number(state1.total_xp_confirmed));
    expect(Number(state2.current_level)).toBe(Number(state1.current_level));
    expect(BigInt(state2.last_reconciled_xp_event_id)).toBe(BigInt(state1.last_reconciled_xp_event_id));
  });

  test('running worker twice does NOT create duplicate level_up_events', async () => {
    const { userId } = await createFreshUser('idem2');
    await insertXpEvent({ userId, xpDeltaSigned: 100 }); // → level 2
    await processUser(BigInt(userId), prisma, levelDefs);
    await processUser(BigInt(userId), prisma, levelDefs);
    const events = await getLevelUpEvents(userId);
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cursor correctness
// ---------------------------------------------------------------------------
describe('Worker — cursor correctness', () => {
  test('worker only processes events with id > last_reconciled_xp_event_id', async () => {
    const { userId } = await createFreshUser('cursor1');
    await insertXpEvent({ userId, xpDeltaSigned: 10 });
    await processUser(BigInt(userId), prisma, levelDefs);
    const state1 = await getProgressState(userId);
    // Simulate inserting an old event with lower id — not possible to force lower id,
    // so verify that second run with no new events leaves state unchanged
    await processUser(BigInt(userId), prisma, levelDefs);
    const state2 = await getProgressState(userId);
    expect(Number(state2.total_xp_confirmed)).toBe(Number(state1.total_xp_confirmed));
  });

  test('new events after first run are processed incrementally on second run', async () => {
    const { userId } = await createFreshUser('cursor2');
    await insertXpEvent({ userId, xpDeltaSigned: 10 });
    await processUser(BigInt(userId), prisma, levelDefs);
    await insertXpEvent({ userId, xpDeltaSigned: 20 });
    await processUser(BigInt(userId), prisma, levelDefs);
    const state = await getProgressState(userId);
    expect(Number(state.total_xp_confirmed)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Pending XP isolation
// ---------------------------------------------------------------------------
describe('Worker — pending XP isolation', () => {
  test('xp_confirmed = false events are never included in totals', async () => {
    const { userId } = await createFreshUser('pend1');
    await insertXpEvent({ userId, xpDeltaSigned: 10, xpConfirmed: true });
    await insertXpEvent({ userId, xpDeltaSigned: 500, xpConfirmed: false });
    await processUser(BigInt(userId), prisma, levelDefs);
    const state = await getProgressState(userId);
    expect(Number(state.total_xp_confirmed)).toBe(10);
  });

  test('xp_confirmed = false events do not trigger level-ups', async () => {
    const { userId } = await createFreshUser('pend2');
    await insertXpEvent({ userId, xpDeltaSigned: 10000, xpConfirmed: false }); // would be level 10
    await processUser(BigInt(userId), prisma, levelDefs);
    const events = await getLevelUpEvents(userId);
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency key constraint
// ---------------------------------------------------------------------------
describe('Idempotency key constraint', () => {
  test('inserting xp_events row with duplicate idempotency_key throws unique constraint error', async () => {
    const { userId } = await createFreshUser('dupkey');
    const key = `test:dup:${Date.now()}:${Math.random()}`;
    await insertXpEvent({ userId, xpDeltaSigned: 10, idempotencyKey: key });
    await expect(
      insertXpEvent({ userId, xpDeltaSigned: 10, idempotencyKey: key })
    ).rejects.toThrow();
  });
});
