'use strict';

// Pure helpers for session timing. No DB access.
//
// Session model recap:
//   - Logical day rolls over at 5 AM local user time.
//   - Morning window: 5 AM ≤ t < 3 PM local
//   - Evening window: 5 PM ≤ t < 3 AM local (next calendar day)
//   - 3 PM–5 PM and 3 AM–5 AM are dead windows.
//
// All inputs accept a Date and an IANA timezone string. Computations rely on
// Intl.DateTimeFormat for timezone-aware wallclock extraction so DST is handled
// correctly.

function getLocalParts(timestamp, ianaTz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(timestamp);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Intl returns hour=24 for midnight in some locales — normalize to 0.
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour,
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10),
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function makeUtcDateOnly(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function shiftDay(year, month, day, deltaDays) {
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/**
 * Compute the logical local-day key for `timestamp` in `ianaTz`, applying the
 * 5 AM rollover. Returns a Date pinned to UTC midnight of the day-only value
 * (so it round-trips through Postgres DATE columns cleanly).
 */
function computeLocalDayKey(timestamp, ianaTz) {
  const parts = getLocalParts(timestamp, ianaTz);
  let { year, month, day, hour } = parts;
  if (hour < 5) {
    const prev = shiftDay(year, month, day, -1);
    year = prev.year;
    month = prev.month;
    day = prev.day;
  }
  return makeUtcDateOnly(year, month, day);
}

/**
 * Resolve which session window `timestamp` belongs to, in `ianaTz`.
 * Returns 'MORNING' (5 AM ≤ t < 3 PM), 'EVENING' (5 PM ≤ t < 3 AM next day),
 * or null in the dead windows.
 */
function resolveSessionWindow(timestamp, ianaTz) {
  const { hour } = getLocalParts(timestamp, ianaTz);
  if (hour >= 5 && hour < 15) return 'MORNING';
  if (hour >= 17 && hour < 24) return 'EVENING';
  if (hour >= 0 && hour < 3) return 'EVENING';
  return null;
}

/**
 * Pure streak math:
 *   - first ever (prev=null) → 1
 *   - same logical day → return prev unchanged
 *   - exactly +1 calendar day → prev+1
 *   - any other gap → reset to 1
 */
function nextStreak(prev, prevLocalDay, currentLocalDay) {
  if (!prevLocalDay) return 1;
  const prevKey = toDayKeyString(prevLocalDay);
  const curKey = toDayKeyString(currentLocalDay);
  if (prevKey === curKey) return prev;
  const expectedNext = addOneDay(prevKey);
  if (curKey === expectedNext) return prev + 1;
  return 1;
}

function toDayKeyString(value) {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  // String form — assume YYYY-MM-DD or longer ISO; trim
  return String(value).slice(0, 10);
}

function addOneDay(dayKey) {
  const [y, m, d] = dayKey.split('-').map((s) => parseInt(s, 10));
  const next = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

module.exports = {
  computeLocalDayKey,
  resolveSessionWindow,
  nextStreak,
  toDayKeyString,
};
