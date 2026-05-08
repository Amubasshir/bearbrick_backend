'use strict';

const { pickBricksForSet } = require('../../../../src/services/sessions/SessionSetService');

const POOL = Array.from({ length: 50 }, (_, i) => `brick-${String(i).padStart(2, '0')}`);

describe('pickBricksForSet — determinism', () => {
  test('same seed → same selection (stable across calls)', () => {
    const a = pickBricksForSet(POOL, 7, 'seed-A');
    const b = pickBricksForSet(POOL, 7, 'seed-A');
    expect(a).toEqual(b);
  });

  test('different seeds → different selections (with high probability)', () => {
    const a = pickBricksForSet(POOL, 7, 'seed-A');
    const b = pickBricksForSet(POOL, 7, 'seed-B');
    expect(a).not.toEqual(b);
  });

  test('returns exactly the requested count', () => {
    expect(pickBricksForSet(POOL, 7, 'morning').length).toBe(7);
    expect(pickBricksForSet(POOL, 11, 'evening').length).toBe(11);
  });

  test('returns only ids drawn from the pool (no fabrication)', () => {
    const picked = pickBricksForSet(POOL, 7, 'seed-x');
    for (const id of picked) {
      expect(POOL).toContain(id);
    }
  });

  test('no duplicates within a single set', () => {
    const picked = pickBricksForSet(POOL, 11, 'seed-y');
    expect(new Set(picked).size).toBe(picked.length);
  });
});

describe('pickBricksForSet — pool boundaries', () => {
  test('pool size equal to count returns all entries (deterministically ordered)', () => {
    const small = ['a', 'b', 'c'];
    const picked = pickBricksForSet(small, 3, 'seed');
    expect(picked.sort()).toEqual(['a', 'b', 'c']);
  });

  test('pool smaller than count returns all available entries (no fabrication)', () => {
    const small = ['a', 'b'];
    const picked = pickBricksForSet(small, 7, 'seed');
    expect(picked.length).toBeLessThanOrEqual(2);
    expect(new Set(picked).size).toBe(picked.length);
  });
});

describe('pickBricksForSet — morning vs evening non-overlap', () => {
  test('caller can produce non-overlapping morning/evening sets by removing morning ids from evening pool', () => {
    const morning = pickBricksForSet(POOL, 7, 'day:2026-05-08:MORNING');
    const remaining = POOL.filter((b) => !morning.includes(b));
    const evening = pickBricksForSet(remaining, 11, 'day:2026-05-08:EVENING');
    const overlap = morning.filter((b) => evening.includes(b));
    expect(overlap).toEqual([]);
  });
});
