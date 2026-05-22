'use strict';

const {
  LIFETIME_PERIOD_KEY,
  utcWeekKey,
  utcWeekStartFromKey,
  utcWeekBounds,
  previousUtcWeekKey,
  nextUtcWeekKey,
} = require('../../../src/lib/utcWeeks');

describe('lib/utcWeeks — UTC ISO-8601 week math', () => {
  describe('utcWeekKey', () => {
    test('mid-week Saturday 2026-05-23 → 2026-W21', () => {
      expect(utcWeekKey(new Date('2026-05-23T12:00:00Z'))).toBe('2026-W21');
    });

    test('Monday 2026-05-18 → 2026-W21 (start of week)', () => {
      expect(utcWeekKey(new Date('2026-05-18T00:00:00Z'))).toBe('2026-W21');
    });

    test('Sunday 2026-05-24 → 2026-W21 (end of week, before rollover)', () => {
      expect(utcWeekKey(new Date('2026-05-24T23:59:59Z'))).toBe('2026-W21');
    });

    test('Monday 2026-05-25 00:00:00 → 2026-W22 (just rolled over)', () => {
      expect(utcWeekKey(new Date('2026-05-25T00:00:00Z'))).toBe('2026-W22');
    });

    test('year-boundary: 2027-01-01 (Friday) → 2026-W53', () => {
      // ISO week year is determined by the Thursday. 2026-12-31 is Thursday,
      // so its ISO week is in 2026 → W53.
      expect(utcWeekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    });

    test('year-boundary: 2026-12-31 (Thursday) → 2026-W53', () => {
      expect(utcWeekKey(new Date('2026-12-31T12:00:00Z'))).toBe('2026-W53');
    });

    test('year-boundary: 2027-01-04 (Monday) → 2027-W01 (first ISO week)', () => {
      expect(utcWeekKey(new Date('2027-01-04T00:00:00Z'))).toBe('2027-W01');
    });

    test('year-boundary: 2026-01-01 (Thursday) → 2026-W01', () => {
      // 2026-01-01 is Thursday → its ISO year is 2026, week 1.
      expect(utcWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    });

    test('year-boundary: 2025-12-31 (Wednesday) → 2026-W01', () => {
      // Thursday of that week is 2026-01-01 → ISO year 2026, week 1.
      expect(utcWeekKey(new Date('2025-12-31T00:00:00Z'))).toBe('2026-W01');
    });

    test('hour-of-day does not affect week assignment', () => {
      const start = utcWeekKey(new Date('2026-05-18T00:00:00Z'));
      const noon = utcWeekKey(new Date('2026-05-18T12:00:00Z'));
      const lastNs = utcWeekKey(new Date('2026-05-24T23:59:59.999Z'));
      expect(start).toBe('2026-W21');
      expect(noon).toBe('2026-W21');
      expect(lastNs).toBe('2026-W21');
    });
  });

  describe('utcWeekStartFromKey', () => {
    test('2026-W21 → Monday 2026-05-18 00:00 UTC', () => {
      expect(utcWeekStartFromKey('2026-W21').toISOString()).toBe('2026-05-18T00:00:00.000Z');
    });

    test('2026-W01 → Monday 2025-12-29 00:00 UTC', () => {
      // 2026-W01 contains 2026-01-01 (Thursday). Monday of that week = 2025-12-29.
      expect(utcWeekStartFromKey('2026-W01').toISOString()).toBe('2025-12-29T00:00:00.000Z');
    });

    test('2026-W53 → Monday 2026-12-28 00:00 UTC', () => {
      // 2026 is a 53-week ISO year. W53 contains 2026-12-31 (Thursday).
      expect(utcWeekStartFromKey('2026-W53').toISOString()).toBe('2026-12-28T00:00:00.000Z');
    });

    test('throws on malformed key', () => {
      expect(() => utcWeekStartFromKey('2026-21')).toThrow();
      expect(() => utcWeekStartFromKey('2026-W5')).toThrow();
      expect(() => utcWeekStartFromKey('not-a-key')).toThrow();
    });

    test('throws on out-of-range week', () => {
      expect(() => utcWeekStartFromKey('2026-W00')).toThrow();
      expect(() => utcWeekStartFromKey('2026-W54')).toThrow();
    });

    test('inverse of utcWeekKey for a sample of dates', () => {
      const samples = [
        '2026-05-18T00:00:00Z',
        '2026-01-01T00:00:00Z',
        '2026-12-31T00:00:00Z',
        '2027-01-04T00:00:00Z',
      ];
      for (const iso of samples) {
        const d = new Date(iso);
        const key = utcWeekKey(d);
        const start = utcWeekStartFromKey(key);
        // The original date should fall within [start, start+7days)
        expect(d.getTime()).toBeGreaterThanOrEqual(start.getTime());
        expect(d.getTime()).toBeLessThan(start.getTime() + 7 * 86_400_000);
      }
    });
  });

  describe('utcWeekBounds', () => {
    test('returns Monday-to-next-Monday for mid-week input', () => {
      const { start, end } = utcWeekBounds(new Date('2026-05-23T12:00:00Z'));
      expect(start.toISOString()).toBe('2026-05-18T00:00:00.000Z');
      expect(end.toISOString()).toBe('2026-05-25T00:00:00.000Z');
    });

    test('start is inclusive, end is exclusive', () => {
      const { start, end } = utcWeekBounds(new Date('2026-05-25T00:00:00.000Z'));
      // 2026-05-25 00:00 is exactly the start of W22.
      expect(start.toISOString()).toBe('2026-05-25T00:00:00.000Z');
      expect(end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });
  });

  describe('previousUtcWeekKey / nextUtcWeekKey', () => {
    test('previous of 2026-W22 is 2026-W21', () => {
      expect(previousUtcWeekKey('2026-W22')).toBe('2026-W21');
    });

    test('previous of 2026-W01 crosses year boundary → 2025-W52', () => {
      // 2025 is a 52-week ISO year. Previous of 2026-W01 = 2025-W52.
      expect(previousUtcWeekKey('2026-W01')).toBe('2025-W52');
    });

    test('next of 2026-W53 crosses year boundary → 2027-W01', () => {
      expect(nextUtcWeekKey('2026-W53')).toBe('2027-W01');
    });

    test('next of 2026-W21 is 2026-W22', () => {
      expect(nextUtcWeekKey('2026-W21')).toBe('2026-W22');
    });

    test('previous(next(k)) === k for several keys', () => {
      const keys = ['2026-W01', '2026-W21', '2026-W53', '2027-W01'];
      for (const k of keys) {
        expect(previousUtcWeekKey(nextUtcWeekKey(k))).toBe(k);
      }
    });
  });

  describe('LIFETIME_PERIOD_KEY', () => {
    test('is the literal string "LIFETIME"', () => {
      expect(LIFETIME_PERIOD_KEY).toBe('LIFETIME');
    });
  });
});
