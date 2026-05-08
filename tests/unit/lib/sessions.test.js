'use strict';

const {
  computeLocalDayKey,
  resolveSessionWindow,
  nextStreak,
} = require('../../../src/lib/sessions');

// ---------------------------------------------------------------------------
// computeLocalDayKey — applies 5AM local rollover, returns date-only string
// (YYYY-MM-DD) or Date. We treat the returned value as comparable via .toString()
// or by reading getUTCFullYear/Month/Date if it's a Date.
// ---------------------------------------------------------------------------

function dayKeyAsString(value) {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

describe('computeLocalDayKey', () => {
  test('UTC: noon UTC on 2026-05-08 → 2026-05-08', () => {
    const ts = new Date('2026-05-08T12:00:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'UTC'))).toBe('2026-05-08');
  });

  test('UTC: 3AM UTC (before 5AM rollover) belongs to PREVIOUS local day', () => {
    const ts = new Date('2026-05-08T03:00:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'UTC'))).toBe('2026-05-07');
  });

  test('UTC: exactly 5:00 AM UTC begins the new local day', () => {
    const ts = new Date('2026-05-08T05:00:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'UTC'))).toBe('2026-05-08');
  });

  test('UTC: 4:59 AM UTC still belongs to previous local day', () => {
    const ts = new Date('2026-05-08T04:59:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'UTC'))).toBe('2026-05-07');
  });

  test('America/New_York: 9 AM UTC on 2026-05-08 = 5 AM EDT, new local day', () => {
    // EDT is UTC-4 in May, so 9:00 UTC = 5:00 local
    const ts = new Date('2026-05-08T09:00:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'America/New_York'))).toBe('2026-05-08');
  });

  test('America/New_York: 8:59 AM UTC = 4:59 EDT, still previous local day', () => {
    const ts = new Date('2026-05-08T08:59:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'America/New_York'))).toBe('2026-05-07');
  });

  test('America/New_York: midnight UTC on 2026-05-09 = 8 PM EDT 2026-05-08', () => {
    const ts = new Date('2026-05-09T00:00:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'America/New_York'))).toBe('2026-05-08');
  });

  test('America/New_York: 1 AM EDT next calendar day still belongs to prior 5AM-day', () => {
    // 5/9 01:00 EDT = 5/9 05:00 UTC. Local time is 1 AM (before 5 AM rollover) →
    // belongs to prior local day = 2026-05-08
    const ts = new Date('2026-05-09T05:00:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'America/New_York'))).toBe('2026-05-08');
  });

  test('DST spring-forward (2026-03-08 EST→EDT): 9 AM UTC = 5 AM EDT, new day', () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT. After DST: UTC offset = -4.
    // 9:00 UTC on 2026-03-08 = 5:00 EDT
    const ts = new Date('2026-03-08T09:00:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'America/New_York'))).toBe('2026-03-08');
  });

  test('DST fall-back (2026-11-01): 10 AM UTC = 5 AM EST, new day', () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST. After: UTC offset = -5.
    // 10:00 UTC on 2026-11-01 = 5:00 EST
    const ts = new Date('2026-11-01T10:00:00Z');
    expect(dayKeyAsString(computeLocalDayKey(ts, 'America/New_York'))).toBe('2026-11-01');
  });
});

// ---------------------------------------------------------------------------
// resolveSessionWindow — Morning 5AM–3PM, Evening 5PM–3AM-next-day, else dead
// ---------------------------------------------------------------------------

describe('resolveSessionWindow', () => {
  test('UTC: 6 AM UTC → MORNING', () => {
    const ts = new Date('2026-05-08T06:00:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBe('MORNING');
  });

  test('UTC: exactly 5 AM UTC → MORNING (inclusive start)', () => {
    const ts = new Date('2026-05-08T05:00:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBe('MORNING');
  });

  test('UTC: 2:59 PM UTC → MORNING (still open)', () => {
    const ts = new Date('2026-05-08T14:59:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBe('MORNING');
  });

  test('UTC: exactly 3 PM UTC → null (dead window starts)', () => {
    const ts = new Date('2026-05-08T15:00:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBeNull();
  });

  test('UTC: 4:59 PM UTC → null (dead window)', () => {
    const ts = new Date('2026-05-08T16:59:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBeNull();
  });

  test('UTC: exactly 5 PM UTC → EVENING (inclusive start)', () => {
    const ts = new Date('2026-05-08T17:00:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBe('EVENING');
  });

  test('UTC: 11 PM UTC → EVENING', () => {
    const ts = new Date('2026-05-08T23:00:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBe('EVENING');
  });

  test('UTC: 1 AM UTC (next calendar day) → EVENING (window crosses midnight)', () => {
    const ts = new Date('2026-05-09T01:00:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBe('EVENING');
  });

  test('UTC: 2:59 AM UTC → EVENING (still open)', () => {
    const ts = new Date('2026-05-09T02:59:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBe('EVENING');
  });

  test('UTC: exactly 3 AM UTC → null (dead window resumes)', () => {
    const ts = new Date('2026-05-09T03:00:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBeNull();
  });

  test('UTC: 4:59 AM UTC → null (early-morning dead window)', () => {
    const ts = new Date('2026-05-09T04:59:00Z');
    expect(resolveSessionWindow(ts, 'UTC')).toBeNull();
  });

  test('America/New_York: 14:00 UTC = 10 AM EDT → MORNING', () => {
    const ts = new Date('2026-05-08T14:00:00Z');
    expect(resolveSessionWindow(ts, 'America/New_York')).toBe('MORNING');
  });

  test('America/New_York: 22:00 UTC = 6 PM EDT → EVENING', () => {
    const ts = new Date('2026-05-08T22:00:00Z');
    expect(resolveSessionWindow(ts, 'America/New_York')).toBe('EVENING');
  });

  test('America/New_York: 19:00 UTC = 3 PM EDT → null (dead window)', () => {
    const ts = new Date('2026-05-08T19:00:00Z');
    expect(resolveSessionWindow(ts, 'America/New_York')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextStreak — pure streak math
// ---------------------------------------------------------------------------

describe('nextStreak', () => {
  test('first ever completion (no prevLocalDay) → 1', () => {
    const today = new Date('2026-05-08');
    expect(nextStreak(0, null, today)).toBe(1);
  });

  test('consecutive day after 1-day streak → 2', () => {
    const yesterday = new Date('2026-05-07');
    const today = new Date('2026-05-08');
    expect(nextStreak(1, yesterday, today)).toBe(2);
  });

  test('skipped a day (gap of 2 days) → resets to 1', () => {
    const twoDaysAgo = new Date('2026-05-06');
    const today = new Date('2026-05-08');
    expect(nextStreak(5, twoDaysAgo, today)).toBe(1);
  });

  test('same day re-completion (no advance) → returns prev', () => {
    const today = new Date('2026-05-08');
    expect(nextStreak(3, today, today)).toBe(3);
  });

  test('long streak +1 on consecutive day → prev+1', () => {
    const yesterday = new Date('2026-05-07');
    const today = new Date('2026-05-08');
    expect(nextStreak(42, yesterday, today)).toBe(43);
  });

  test('accepts string-form ISO date keys for prev/current', () => {
    expect(nextStreak(1, '2026-05-07', '2026-05-08')).toBe(2);
    expect(nextStreak(1, '2026-05-06', '2026-05-08')).toBe(1);
  });
});
