'use strict';

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../../src/lib/prisma');
const { app, uniqueEmail } = require('../helpers/dex');

afterAll(async () => {
  await prisma.$disconnect();
});

// Helpers ---------------------------------------------------------------------

async function createPublishedBrick() {
  const id = uuidv4();
  await prisma.brick.create({
    data: {
      id,
      name: 'Guest test brick',
      descriptionShort: 'Brick for guest conversion test',
      status: 'PUBLISHED',
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

async function createRotationCycle() {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO session_rotation_cycles (started_at, pool_size)
     VALUES (NOW(), 0)
     RETURNING id`
  );
  return rows[0].id;
}

function localHour(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  return h === 24 ? 0 : h;
}

// Pick an IANA timezone where the current wallclock falls inside the MORNING
// window (5AM–3PM local). The carry path only fires when the user signs up
// inside the matching window, so the test must run with a timezone that is
// "currently morning" regardless of when the suite runs.
function pickMorningTz() {
  const candidates = [
    'UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo',
    'Europe/London', 'Australia/Sydney', 'Asia/Kolkata', 'America/Sao_Paulo',
    'Asia/Dubai', 'Pacific/Auckland', 'America/Anchorage', 'Pacific/Honolulu',
    'Asia/Singapore', 'Europe/Berlin', 'Europe/Moscow',
  ];
  for (const tz of candidates) {
    const h = localHour(tz);
    if (h >= 5 && h < 15) return tz;
  }
  return null;
}

function localDayKeyFor(tz) {
  // Apply 5AM rollover in the given timezone.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = dtf.formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let y = parseInt(map.year, 10);
  let m = parseInt(map.month, 10);
  let d = parseInt(map.day, 10);
  let h = parseInt(map.hour, 10);
  if (h === 24) h = 0;
  if (h < 5) {
    const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    t.setUTCDate(t.getUTCDate() - 1);
    y = t.getUTCFullYear();
    m = t.getUTCMonth() + 1;
    d = t.getUTCDate();
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function ensureSessionSet(localDayKey, kind, brickIds, rotationCycleId) {
  // Race-safe: get-or-create the set (unique on local_day_key, kind), then
  // always attempt to insert our items with ON CONFLICT DO NOTHING so the
  // test's brick_ids end up in the set regardless of prior state.
  await prisma.$queryRawUnsafe(
    `INSERT INTO daily_session_sets (local_day_key, kind, rotation_cycle_id)
     VALUES ($1::date, $2::"SessionKind", $3::uuid)
     ON CONFLICT (local_day_key, kind) DO NOTHING`,
    localDayKey, kind, rotationCycleId
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, rotation_cycle_id FROM daily_session_sets
     WHERE local_day_key = $1::date AND kind = $2::"SessionKind"`,
    localDayKey, kind
  );
  const setId = rows[0].id;
  const setCycleId = rows[0].rotation_cycle_id;
  // Use the set's existing rotation cycle so the (cycle, brick) unique stays satisfied.
  // Slot index uses a monotonically growing offset based on existing items to dodge collisions.
  const existingCount = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM daily_session_set_items WHERE session_set_id = $1::uuid`,
    setId
  );
  const offset = Number(existingCount[0].n);
  for (let i = 0; i < brickIds.length; i++) {
    await prisma.$queryRawUnsafe(
      `INSERT INTO daily_session_set_items
         (session_set_id, brick_id, slot_index, rotation_cycle_id)
       VALUES ($1::uuid, $2, $3, $4::uuid)
       ON CONFLICT DO NOTHING`,
      setId, brickIds[i], offset + i, setCycleId
    );
  }
  return setId;
}

// Tests -----------------------------------------------------------------------

describe('POST /api/signup — guest session conversion', () => {
  test('signup without guest_session payload succeeds normally', async () => {
    const res = await request(app).post('/api/signup').send({
      name: 'Plain Signup',
      email: uniqueEmail(),
      password: 'password123',
      email_verified: true,
    });
    expect(res.status).toBe(201);
  });

  test('signup with valid guest_session carries partial brick counts when window still active', async () => {
    const tz = pickMorningTz();
    if (!tz) {
      // Should never happen across all 24h, but bail safely.
      return;
    }
    const dayKey = localDayKeyFor(tz);
    // Use the *existing* (or JIT-built) today's MORNING set so we don't
    // pollute the shared set assertions other test files run against.
    // First, trigger a JIT build via the route by signing up a throwaway user.
    const seedRes = await request(app).post('/api/signup').send({
      name: 'Seed', email: uniqueEmail(), password: 'password123',
      email_verified: true, timezone: tz,
    });
    const seedToken = seedRes.body.data.token;
    const todayRes = await request(app)
      .get('/api/sessions/today')
      .set('Authorization', `Bearer ${seedToken}`);
    expect(todayRes.status).toBe(200);
    if (todayRes.body.data.current_window !== 'MORNING') return;

    const setRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM daily_session_sets
        WHERE local_day_key = $1::date AND kind = 'MORNING'`,
      dayKey
    );
    const setId = setRows[0].id;
    const items = await prisma.$queryRawUnsafe(
      `SELECT brick_id FROM daily_session_set_items
        WHERE session_set_id = $1::uuid
        ORDER BY slot_index ASC LIMIT 3`,
      setId
    );
    const carriedBrickIds = items.map((r) => r.brick_id);
    expect(carriedBrickIds.length).toBeGreaterThanOrEqual(1);

    const guestSession = {
      session_set_id: setId,
      kind: 'MORNING',
      local_day_key: dayKey,
      brick_ids: carriedBrickIds,
    };

    const res = await request(app).post('/api/signup').send({
      name: 'Guest Signup',
      email: uniqueEmail(),
      password: 'password123',
      email_verified: true,
      timezone: tz,
      guest_session: guestSession,
    });

    expect(res.status).toBe(201);
    const userId = res.body.data?.user?.id;
    expect(userId).toBeDefined();

    // Inspect carry: counted brick rows should exist for each carried brick.
    const counts = await prisma.$queryRawUnsafe(
      `SELECT brick_id FROM user_session_brick_counts
       WHERE user_id = $1 AND session_set_id = $2::uuid`,
      BigInt(userId),
      setId
    );
    expect(counts.length).toBe(carriedBrickIds.length);

    // Progress row should reflect the carried partial_count
    const progress = await prisma.$queryRawUnsafe(
      `SELECT partial_count FROM user_session_progress
       WHERE user_id = $1 AND session_set_id = $2::uuid`,
      BigInt(userId),
      setId
    );
    expect(progress.length).toBe(1);
    expect(Number(progress[0].partial_count)).toBe(carriedBrickIds.length);
  });

  test('signup with expired guest_session resets to zero, no carry', async () => {
    const cycleId = await createRotationCycle();
    const brickIds = [];
    for (let i = 0; i < 7; i++) brickIds.push(await createPublishedBrick());
    // Use a clearly-past date so the window has expired
    const expiredKey = '2025-01-01';
    const setId = await ensureSessionSet(expiredKey, 'MORNING', brickIds, cycleId);

    const guestSession = {
      session_set_id: setId,
      kind: 'MORNING',
      local_day_key: expiredKey,
      brick_ids: [brickIds[0], brickIds[1]],
    };

    const res = await request(app).post('/api/signup').send({
      name: 'Expired Guest',
      email: uniqueEmail(),
      password: 'password123',
      email_verified: true,
      timezone: 'UTC',
      guest_session: guestSession,
    });

    expect(res.status).toBe(201);
    const userId = res.body.data?.user?.id;

    const counts = await prisma.$queryRawUnsafe(
      `SELECT brick_id FROM user_session_brick_counts
       WHERE user_id = $1 AND session_set_id = $2::uuid`,
      BigInt(userId),
      setId
    );
    expect(counts.length).toBe(0);
  });
});
