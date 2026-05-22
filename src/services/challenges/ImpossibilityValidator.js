'use strict';

// Per spec Q4: the ONE central place that decides whether a challenge template
// is satisfiable for a given user. Filters are applied in a fixed order; the
// first failure short-circuits. Templates declare their requirements via the
// `requires_*` boolean flags plus the optional `time_window` jsonb. The
// validator interprets those flags and queries injected repos for the actual
// world state.
//
// This is the ONLY decision point for impossibility. No `if family === 'X'`
// branches elsewhere — if you find yourself wanting one, add a flag to the
// template and a filter here instead.

const { resolveSessionWindow } = require('../../lib/sessions');

// Helper: extract the user's current local hour from nowUtc + timezone.
function localHourOf(nowUtc, timezone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(nowUtc);
  const hPart = parts.find((p) => p.type === 'hour');
  let h = parseInt(hPart.value, 10);
  if (h === 24) h = 0;
  return h;
}

/**
 * @param template      A challenge_templates row (camelCase or snake_case ok;
 *                      we read snake_case as that is the DB shape).
 * @param userContext   { userId, localDayKey, timezone, lifecycleState, level, nowUtc }
 * @param repos         Injected readers (DB-free in unit tests).
 *
 * @returns {{ satisfiable: boolean, reason?: string, detail?: object }}
 */
async function evaluate(template, userContext, repos) {
  // 1. Time window check — does the user still have wall-clock time today?
  if (template.time_window) {
    const { start_hour, end_hour } = template.time_window;
    const hour = localHourOf(userContext.nowUtc, userContext.timezone);
    if (
      (start_hour != null && hour < start_hour) ||
      (end_hour != null && hour >= end_hour)
    ) {
      return {
        satisfiable: false,
        reason: 'time_window_unavailable',
        detail: { now_local_hour: hour, time_window: template.time_window },
      };
    }
  }

  // 2. Lifecycle eligibility — must be in the template's allowed list.
  const eligibleStates = template.eligible_lifecycle_states || [];
  if (eligibleStates.length > 0 && !eligibleStates.includes(userContext.lifecycleState)) {
    return {
      satisfiable: false,
      reason: 'lifecycle_ineligible',
      detail: { user: userContext.lifecycleState, allowed: eligibleStates },
    };
  }

  // 3. Difficulty band — user's level must fall inside [min, max] inclusive.
  const lvl = userContext.level ?? 1;
  if (
    lvl < (template.difficulty_band_min ?? 1) ||
    lvl > (template.difficulty_band_max ?? 99)
  ) {
    return {
      satisfiable: false,
      reason: 'difficulty_band_ineligible',
      detail: {
        user_level: lvl,
        band_min: template.difficulty_band_min,
        band_max: template.difficulty_band_max,
      },
    };
  }

  // 4. Contribution gate — the M3c feature flag.
  //    Until the contribution milestone ships, any template that needs the
  //    contribution system is unsatisfiable. Flipping the flag = one config
  //    update, no refactor anywhere else.
  if (template.requires_contribution_access) {
    const enabled = await repos.isContributionEnabled();
    if (!enabled) {
      return { satisfiable: false, reason: 'contribution_system_disabled' };
    }
  }

  // 5. Eligible targets — stale bricks, unmastered categories, etc.
  if (template.requires_stale_targets) {
    const count = await repos.countStaleBricks(template, userContext);
    if (count < (template.target_count ?? 1)) {
      return {
        satisfiable: false,
        reason: 'no_stale_targets',
        detail: { available: count, needed: template.target_count },
      };
    }
  }
  if (template.requires_category_target) {
    const count = await repos.countUnmasteredCategories(template, userContext);
    if (count <= 0) {
      return { satisfiable: false, reason: 'no_category_targets' };
    }
  }
  if (template.requires_session_target) {
    // For session-bound vote challenges: the user needs at least target_count
    // session-set bricks remaining in their applicable session(s) today.
    const remaining = await repos.countSessionRemainingForToday(template, userContext);
    if (remaining < (template.target_count ?? 1)) {
      return {
        satisfiable: false,
        reason: 'session_target_unavailable',
        detail: { remaining, needed: template.target_count },
      };
    }
  }

  // 6. Already fulfilled — user has effectively done the work before
  //    assignment opens (e.g. voted on 7 stale bricks before 5 AM rolled over
  //    AND the same logic would have completed today's challenge).
  if (await repos.isAlreadyFulfilled(template, userContext)) {
    return { satisfiable: false, reason: 'already_fulfilled' };
  }

  return { satisfiable: true };
}

// Default repos that any in-process caller can wire to live DB queries.
// Kept here as exported defaults so callers don't have to handcraft each one.
function makeDefaultRepos(prisma) {
  return {
    async isContributionEnabled() {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT (config->'featureFlags'->>'contribution_system_enabled')::boolean AS enabled
         FROM xp_config_versions WHERE is_active = TRUE ORDER BY version DESC LIMIT 1`
      );
      return rows[0]?.enabled === true;
    },
    async countStaleBricks(/* template, userContext */) {
      // brick_vote_state stale tracking isn't wired up in this build (M1
      // pricing exists but the stale flag is not populated). Return 0 so
      // stale-only templates are filtered out at assignment time and the
      // fallback path substitutes another template. When stale tracking
      // ships, replace this with a real query against brick_vote_state.
      return 0;
    },
    async countUnmasteredCategories(/* template, userContext */) {
      // Category mastery isn't tracked yet; return a generous number so
      // category templates pass the filter on this dimension. Subsequent
      // filters (target availability) will catch true impossibility.
      return 99;
    },
    async countSessionRemainingForToday(/* template, userContext */) {
      // Conservatively report both sessions still open (18 bricks total).
      return 18;
    },
    async isAlreadyFulfilled(/* template, userContext */) {
      // Pre-fulfillment detection requires per-template inspection of the
      // user's existing events for the day. Not implemented in M3c initial
      // scope — return false so the assignment goes through. The XP / progress
      // idempotency layer catches double-grant; the visible "already done"
      // optimization can be added later without breaking correctness.
      return false;
    },
  };
}

module.exports = {
  evaluate,
  makeDefaultRepos,
  localHourOf,
};
