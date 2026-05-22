'use strict';

const {
  mondayOf,
  weekKeyOf,
  nextLocalResetUtc,
  nextLocalMondayResetUtc,
} = require('../../../src/lib/weeks');
const { toDayKeyString } = require('../../../src/lib/sessions');

describe('lib/weeks — Monday / week-key helpers', () => {
  describe('mondayOf', () => {
    test('a Monday returns itself', () => {
      // 2026-05-18 is a Monday
      expect(toDayKeyString(mondayOf('2026-05-18'))).toBe('2026-05-18');
    });

    test('Tuesday → previous Monday', () => {
      expect(toDayKeyString(mondayOf('2026-05-19'))).toBe('2026-05-18');
    });

    test('Sunday → previous Monday (6 days back, not next day)', () => {
      expect(toDayKeyString(mondayOf('2026-05-24'))).toBe('2026-05-18');
    });

    test('Saturday → previous Monday', () => {
      expect(toDayKeyString(mondayOf('2026-05-23'))).toBe('2026-05-18');
    });

    test('handles year boundary — 2026-01-01 (Thursday) → 2025-12-29 Monday', () => {
      expect(toDayKeyString(mondayOf('2026-01-01'))).toBe('2025-12-29');
    });

    test('accepts a Date object (UTC midnight of local day)', () => {
      const d = new Date(Date.UTC(2026, 4, 19, 0, 0, 0, 0)); // Tue 2026-05-19
      expect(toDayKeyString(mondayOf(d))).toBe('2026-05-18');
    });

    test('weekKeyOf is an alias of mondayOf', () => {
      expect(toDayKeyString(weekKeyOf('2026-05-22'))).toBe(
        toDayKeyString(mondayOf('2026-05-22'))
      );
    });
  });

  describe('nextLocalResetUtc', () => {
    test('UTC timezone — next 5AM is next-day 05:00 UTC', () => {
      const localDayKey = '2026-05-18';
      const got = nextLocalResetUtc(localDayKey, 'UTC');
      expect(got.toISOString()).toBe('2026-05-19T05:00:00.000Z');
    });

    test('Asia/Tokyo (UTC+9) — next-day 5AM local = previous day 20:00 UTC', () => {
      const localDayKey = '2026-05-18';
      // Next local day 2026-05-19 at 05:00 JST = 2026-05-18 20:00 UTC
      const got = nextLocalResetUtc(localDayKey, 'Asia/Tokyo');
      expect(got.toISOString()).toBe('2026-05-18T20:00:00.000Z');
    });

    test('America/New_York during EDT (UTC-4) — next-day 5AM local = same date 09:00 UTC', () => {
      // 2026-05-18 in EDT: next reset is 2026-05-19 05:00 EDT = 2026-05-19 09:00 UTC
      const got = nextLocalResetUtc('2026-05-18', 'America/New_York');
      expect(got.toISOString()).toBe('2026-05-19T09:00:00.000Z');
    });

    test('respects custom resetHour parameter', () => {
      const got = nextLocalResetUtc('2026-05-18', 'UTC', 3);
      expect(got.toISOString()).toBe('2026-05-19T03:00:00.000Z');
    });
  });

  describe('nextLocalMondayResetUtc', () => {
    test('UTC — Monday 2026-05-18 → next Monday 2026-05-25 at 05:00 UTC', () => {
      const got = nextLocalMondayResetUtc('2026-05-18', 'UTC');
      expect(got.toISOString()).toBe('2026-05-25T05:00:00.000Z');
    });

    test('UTC — Wednesday 2026-05-20 → still next Monday 2026-05-25 at 05:00 UTC', () => {
      const got = nextLocalMondayResetUtc('2026-05-20', 'UTC');
      expect(got.toISOString()).toBe('2026-05-25T05:00:00.000Z');
    });

    test('UTC — Sunday 2026-05-24 → next Monday 2026-05-25 at 05:00 UTC (not next-next)', () => {
      const got = nextLocalMondayResetUtc('2026-05-24', 'UTC');
      expect(got.toISOString()).toBe('2026-05-25T05:00:00.000Z');
    });

    test('Asia/Tokyo Monday → next Monday 05:00 JST = Sunday 20:00 UTC', () => {
      const got = nextLocalMondayResetUtc('2026-05-18', 'Asia/Tokyo');
      // 2026-05-25 05:00 JST = 2026-05-24 20:00 UTC
      expect(got.toISOString()).toBe('2026-05-24T20:00:00.000Z');
    });
  });
});
