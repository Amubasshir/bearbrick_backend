'use strict';

// Pure helpers for UTC ISO-8601 week math. No DB access.
//
// Why a separate helper from src/lib/weeks.js:
//   - weeks.js handles LOCAL Monday-5AM math for the M3b/M3c daily/weekly
//     challenge reset model (local user timezone).
//   - utcWeeks.js handles GLOBAL UTC ISO-week math for M3d leaderboards
//     (single global clock per Spec_ANSWERS Q9).
//
// Period key format: 'YYYY-Www' where Www is zero-padded ISO week number
// (W01..W53). The ISO week year is the calendar year of the Thursday in
// that week — so 2026-01-01 (Thursday) is in 2026-W01, but 2027-01-01
// (Friday) is in 2026-W53.
//
// All inputs/outputs are UTC. Local time is irrelevant here.

const LIFETIME_PERIOD_KEY = 'LIFETIME';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Compute the ISO 8601 week-numbering year and week number for a UTC Date.
 * Uses the canonical algorithm: shift to the Thursday of the current week,
 * its calendar year is the ISO year. Week 1 is the week containing that
 * Thursday's January 4th.
 *
 * @param {Date} utcDate
 * @returns {{year:number, week:number}}
 */
function isoWeekParts(utcDate) {
  // Work on a UTC-day copy so wall-clock time doesn't matter.
  const d = new Date(Date.UTC(
    utcDate.getUTCFullYear(),
    utcDate.getUTCMonth(),
    utcDate.getUTCDate()
  ));
  // ISO day-of-week: Monday=1..Sunday=7
  const isoDow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Shift to the Thursday of this ISO week — that Thursday's year IS the ISO year.
  d.setUTCDate(d.getUTCDate() + (4 - isoDow));
  const isoYear = d.getUTCFullYear();
  // Week number = floor diff in days from Jan 4 (always in W01) / 7 + 1
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  // Monday of W01
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - (jan4Dow - 1)));
  const diffDays = Math.round((d - week1Monday) / 86_400_000);
  const week = Math.floor(diffDays / 7) + 1;
  return { year: isoYear, week };
}

/**
 * Returns the ISO-8601 week key for a UTC instant, format 'YYYY-Www'.
 * @example
 *   utcWeekKey(new Date('2026-05-23T12:00:00Z'))  →  '2026-W21'
 *   utcWeekKey(new Date('2027-01-01T00:00:00Z'))  →  '2026-W53'
 */
function utcWeekKey(utcDate) {
  const { year, week } = isoWeekParts(utcDate);
  return `${year}-W${pad2(week)}`;
}

/**
 * Returns the UTC instant of the Monday 00:00:00.000 that starts the ISO week
 * named by `weekKey`. Inverse of utcWeekKey.
 * @param {string} weekKey  Format 'YYYY-Www'
 * @returns {Date}
 */
function utcWeekStartFromKey(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) {
    throw new Error(`utcWeekStartFromKey: invalid week_key "${weekKey}" — expected 'YYYY-Www'`);
  }
  const year = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);
  if (week < 1 || week > 53) {
    throw new Error(`utcWeekStartFromKey: week ${week} out of range for ${weekKey}`);
  }
  // Monday of W01 of the given ISO year (using the same algorithm as isoWeekParts).
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(Date.UTC(year, 0, 4 - (jan4Dow - 1)));
  // Advance (week - 1) * 7 days.
  return new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);
}

/**
 * Returns { start, end } UTC instants of the ISO week containing `utcDate`.
 * Monday 00:00:00.000 inclusive → next Monday 00:00:00.000 exclusive.
 */
function utcWeekBounds(utcDate) {
  const key = utcWeekKey(utcDate);
  const start = utcWeekStartFromKey(key);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { start, end };
}

/**
 * Returns the week_key for the ISO week immediately preceding `weekKey`.
 * Handles year boundaries: previous of '2026-W01' is '2025-W53' (or W52).
 */
function previousUtcWeekKey(weekKey) {
  const start = utcWeekStartFromKey(weekKey);
  const prev = new Date(start.getTime() - 7 * 86_400_000);
  return utcWeekKey(prev);
}

/**
 * Returns the week_key for the ISO week immediately after `weekKey`.
 */
function nextUtcWeekKey(weekKey) {
  const start = utcWeekStartFromKey(weekKey);
  const next = new Date(start.getTime() + 7 * 86_400_000);
  return utcWeekKey(next);
}

module.exports = {
  LIFETIME_PERIOD_KEY,
  utcWeekKey,
  utcWeekStartFromKey,
  utcWeekBounds,
  previousUtcWeekKey,
  nextUtcWeekKey,
  // exposed for testing internal correctness
  isoWeekParts,
};
