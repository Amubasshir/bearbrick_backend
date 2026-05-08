'use strict';

const { nextStreak, toDayKeyString } = require('../../lib/sessions');

/**
 * Apply a session completion to user_streak_state. Returns the new streak count.
 * Writes a streak_break_events row if the streak resets to 1 from a non-zero state.
 */
async function applyCompletion(tx, userId, kind, localDayKey) {
  const userIdBig = BigInt(userId);
  const dayIso = toDayKeyString(localDayKey);

  // Bootstrap row if missing
  await tx.$queryRawUnsafe(
    `INSERT INTO user_streak_state (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    userIdBig
  );

  const rows = await tx.$queryRawUnsafe(
    `SELECT morning_streak, morning_last_completed_local_day, morning_longest,
            evening_streak, evening_last_completed_local_day, evening_longest
       FROM user_streak_state
      WHERE user_id = $1
      FOR UPDATE`,
    userIdBig
  );
  const state = rows[0];

  const isMorning = kind === 'MORNING';
  const prev = Number(isMorning ? state.morning_streak : state.evening_streak);
  const prevDay = isMorning
    ? state.morning_last_completed_local_day
    : state.evening_last_completed_local_day;
  const longest = Number(isMorning ? state.morning_longest : state.evening_longest);

  const next = nextStreak(prev, prevDay, dayIso);
  const newLongest = Math.max(longest, next);

  // Detect a break: prev > 0, and the streak just reset to 1 (i.e. there was a gap).
  if (prev > 0 && next === 1 && prevDay) {
    await tx.$queryRawUnsafe(
      `INSERT INTO streak_break_events (user_id, kind, from_streak, local_day_key)
       VALUES ($1, $2::"SessionKind", $3, $4::date)`,
      userIdBig, kind, prev, dayIso
    );
  }

  if (isMorning) {
    await tx.$queryRawUnsafe(
      `UPDATE user_streak_state
          SET morning_streak                   = $2,
              morning_last_completed_local_day = $3::date,
              morning_longest                  = $4,
              updated_at                       = NOW()
        WHERE user_id = $1`,
      userIdBig, next, dayIso, newLongest
    );
  } else {
    await tx.$queryRawUnsafe(
      `UPDATE user_streak_state
          SET evening_streak                   = $2,
              evening_last_completed_local_day = $3::date,
              evening_longest                  = $4,
              updated_at                       = NOW()
        WHERE user_id = $1`,
      userIdBig, next, dayIso, newLongest
    );
  }

  return next;
}

module.exports = { applyCompletion };
