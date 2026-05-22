'use strict';

// Pure helpers for weekly resets and "next local Nam UTC" math. No DB access.
//
// Week model recap (per spec Q9 + project-overview):
//   - Weekly *challenges* reset Monday 5 AM in the user's local timezone.
//   - Weekly *leaderboards* reset on a global UTC clock (out of scope here).
//   - The week_key for a weekly assignment is the local Monday DATE that opens
//     the user's logical week. Same shape as local_day_key (UTC-midnight DATE).
//
// nextLocalResetUtc / nextLocalMondayResetUtc convert "wall-clock time in TZ"
// into an authoritative UTC instant. We use the standard fixed-point trick:
// pick a UTC candidate, see what local time it produces, adjust by the delta,
// repeat until stable. Handles DST correctly because each iteration narrows
// the offset.

const { toDayKeyString } = require('./sessions');

function addOneDay(dayKey) {
  const [y, m, d] = dayKey.split('-').map((s) => parseInt(s, 10));
  const next = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseDayKey(value) {
  const s = toDayKeyString(value);
  const [y, m, d] = s.split('-').map((p) => parseInt(p, 10));
  return { y, m, d };
}

function makeUtcDateOnly(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

/**
 * Return the Monday of the calendar week containing `localDayKey`, expressed
 * as a UTC-midnight Date (same shape as local_day_key). Week starts Monday.
 * If the input is already a Monday, returns it as-is.
 */
function mondayOf(localDayKey) {
  const { y, m, d } = parseDayKey(localDayKey);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  // getUTCDay: Sunday=0..Saturday=6. Distance back to Monday=1.
  const dow = anchor.getUTCDay();
  const offset = dow === 0 ? -6 : -(dow - 1);
  anchor.setUTCDate(anchor.getUTCDate() + offset);
  return makeUtcDateOnly(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth() + 1,
    anchor.getUTCDate()
  );
}

/**
 * Alias of mondayOf — emphasises that the returned value IS the week_key
 * for persistence in user_challenge_assignments.assignment_week_key.
 */
function weekKeyOf(localDayKey) {
  return mondayOf(localDayKey);
}

// Reuse the timezone-aware wallclock extractor from sessions.js by inlining
// (avoid circular import discomfort — same shape, kept local).
function getLocalPartsLocal(timestamp, ianaTz) {
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

/**
 * Return the UTC instant when, in `ianaTz`, the wall clock reads
 * `(nextDay(localDayKey)) resetHour:00:00`. This is the canonical
 * `expires_at` for a daily assignment opened at `localDayKey`.
 *
 * @param {Date|string} localDayKey  The day the assignment was opened.
 * @param {string}      ianaTz       IANA timezone (e.g. 'Asia/Tokyo').
 * @param {number}      resetHour    Defaults to 5 (5 AM local reset).
 * @returns {Date}                   UTC instant of the next reset.
 */
function nextLocalResetUtc(localDayKey, ianaTz, resetHour = 5) {
  const todayKey = toDayKeyString(localDayKey);
  const targetKey = addOneDay(todayKey);
  const [ty, tm, td] = targetKey.split('-').map((p) => parseInt(p, 10));

  // Initial guess: treat the target wall-clock as UTC. Will be off by the
  // timezone offset; we converge via fixed-point.
  let candidate = new Date(Date.UTC(ty, tm - 1, td, resetHour, 0, 0, 0));

  // 2 iterations is sufficient outside DST jumps; 4 is paranoia-safe.
  for (let i = 0; i < 4; i++) {
    const p = getLocalPartsLocal(candidate, ianaTz);
    if (p.year === ty && p.month === tm && p.day === td && p.hour === resetHour && p.minute === 0) {
      return candidate;
    }
    const observedUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const targetUtc   = Date.UTC(ty, tm - 1, td, resetHour, 0, 0, 0);
    candidate = new Date(candidate.getTime() + (targetUtc - observedUtc));
  }
  return candidate;
}

/**
 * UTC instant of the next Monday 5 AM (in `ianaTz`) AFTER the week containing
 * `localDayKey`. Used as `expires_at` for weekly assignments.
 */
function nextLocalMondayResetUtc(localDayKey, ianaTz, resetHour = 5) {
  const thisMonday = mondayOf(localDayKey);
  const thisMondayKey = toDayKeyString(thisMonday);
  // Next Monday = this Monday + 7 days
  const [y, m, d] = thisMondayKey.split('-').map((p) => parseInt(p, 10));
  const next = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  next.setUTCDate(next.getUTCDate() + 7);
  const nextMondayKey = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;

  // We want resetHour:00 LOCAL on nextMondayKey. Reuse nextLocalResetUtc by
  // passing (nextMondayKey - 1 day) as the "today" so its addOneDay lands on
  // nextMondayKey.
  const [ny, nm, nd] = nextMondayKey.split('-').map((p) => parseInt(p, 10));
  const dayBefore = new Date(Date.UTC(ny, nm - 1, nd, 12, 0, 0, 0));
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const dayBeforeKey = `${dayBefore.getUTCFullYear()}-${pad2(dayBefore.getUTCMonth() + 1)}-${pad2(dayBefore.getUTCDate())}`;

  return nextLocalResetUtc(dayBeforeKey, ianaTz, resetHour);
}

module.exports = {
  mondayOf,
  weekKeyOf,
  nextLocalResetUtc,
  nextLocalMondayResetUtc,
};
