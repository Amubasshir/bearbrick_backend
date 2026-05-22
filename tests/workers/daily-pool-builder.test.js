'use strict';

// Integration test against the real DB. Templates are pre-seeded by migration
// 20260701000900_challenge_templates_seed (3 vote / 2 explore / 2 maintain / 2
// category_mastery / 2 contribute daily templates).

const prisma = require('../../src/lib/prisma');
const { ensureDailyPool } = require('../../src/services/challenges/PoolBuilderService');

const TEST_DATE_PREFIX = '2099-09-'; // far-future date space we own

async function clearPoolForDate(dateIso) {
  await prisma.$queryRawUnsafe(
    `DELETE FROM challenge_daily_pool WHERE challenge_date = $1::date`,
    dateIso
  );
}

describe('PoolBuilderService.ensureDailyPool', () => {
  let datesUsed = [];

  function freshDate(suffix) {
    const d = `${TEST_DATE_PREFIX}${suffix}`;
    datesUsed.push(d);
    return d;
  }

  afterAll(async () => {
    for (const d of datesUsed) await clearPoolForDate(d);
    await prisma.$disconnect();
  });

  test('builds 7 slots on first call with the expected family mix', async () => {
    const date = freshDate('01');
    await clearPoolForDate(date);

    await ensureDailyPool(date, prisma);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT slot_type, family FROM challenge_daily_pool WHERE challenge_date = $1::date
        ORDER BY position ASC`,
      date
    );
    expect(rows).toHaveLength(7);

    const slotFamilies = Object.fromEntries(rows.map((r) => [r.slot_type, r.family]));
    expect(slotFamilies.vote_1).toBe('vote');
    expect(slotFamilies.vote_2).toBe('vote');
    expect(slotFamilies.explore).toBe('explore');
    expect(slotFamilies.maintain).toBe('maintain');
    expect(slotFamilies.category_mastery).toBe('category_mastery');
    expect(slotFamilies.contribute).toBe('contribute');
    // wildcard slot can be any family; just confirm the row exists with some family
    expect(slotFamilies.wildcard).toBeTruthy();
  });

  test('vote_1 and vote_2 pick DIFFERENT templates (no duplicate)', async () => {
    const date = freshDate('02');
    await clearPoolForDate(date);
    await ensureDailyPool(date, prisma);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT slot_type, template_id FROM challenge_daily_pool
        WHERE challenge_date = $1::date AND slot_type IN ('vote_1', 'vote_2')`,
      date
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].template_id).not.toEqual(rows[1].template_id);
  });

  test('idempotent — second call is a no-op', async () => {
    const date = freshDate('03');
    await clearPoolForDate(date);
    await ensureDailyPool(date, prisma);
    const before = await prisma.$queryRawUnsafe(
      `SELECT id, template_id FROM challenge_daily_pool WHERE challenge_date = $1::date ORDER BY position ASC`,
      date
    );
    await ensureDailyPool(date, prisma);
    const after = await prisma.$queryRawUnsafe(
      `SELECT id, template_id FROM challenge_daily_pool WHERE challenge_date = $1::date ORDER BY position ASC`,
      date
    );
    expect(after).toEqual(before);
  });

  test('concurrent calls do not duplicate slots (race-safe via UNIQUE)', async () => {
    const date = freshDate('04');
    await clearPoolForDate(date);
    await Promise.all([
      ensureDailyPool(date, prisma),
      ensureDailyPool(date, prisma),
      ensureDailyPool(date, prisma),
    ]);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM challenge_daily_pool WHERE challenge_date = $1::date`,
      date
    );
    expect(rows[0].n).toBe(7);
  });

  test('deterministic — same date produces same template_id assignments', async () => {
    const date = freshDate('05');
    await clearPoolForDate(date);
    await ensureDailyPool(date, prisma);
    const first = await prisma.$queryRawUnsafe(
      `SELECT slot_type, template_id FROM challenge_daily_pool WHERE challenge_date = $1::date ORDER BY slot_type`,
      date
    );

    await clearPoolForDate(date);
    await ensureDailyPool(date, prisma);
    const second = await prisma.$queryRawUnsafe(
      `SELECT slot_type, template_id FROM challenge_daily_pool WHERE challenge_date = $1::date ORDER BY slot_type`,
      date
    );

    expect(second).toEqual(first);
  });
});
