'use strict';

// Thin read layer over leaderboard_definitions plus the active v4
// xp_config_versions.leaderboard block. Adding a new board after launch =
// inserting a row; the worker picks it up on the next tick via listActive().
//
// resolveDefinition merges in the config defaults so the worker / read API
// see a fully-resolved definition (no scattered "if eligibilityRule is empty,
// fall back to config" logic at the call sites).

const prisma = require('../../lib/prisma');
const { utcWeekKey, LIFETIME_PERIOD_KEY } = require('../../lib/utcWeeks');

/**
 * Load the M3d leaderboard config block from the active xp_config_versions
 * row (v4). Returns defaults if any keys are missing — for forward safety
 * after future config bumps.
 */
async function loadLeaderboardConfig(prismaClient = prisma) {
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT config FROM xp_config_versions
      WHERE is_active = TRUE
      ORDER BY version DESC
      LIMIT 1`
  );
  const cfg = rows[0]?.config?.leaderboard || {};
  return {
    defaultAntiSnipingWindowSeconds: cfg.default_anti_sniping_window_seconds ?? 300,
    topSnapshotSize: cfg.top_snapshot_size ?? 10,
    eligibilityDefaults: cfg.eligibility_defaults || {},
    aroundMeWindow: cfg.around_me_window ?? 5,
  };
}

/**
 * Hydrate a raw leaderboard_definitions row into the shape the worker and
 * read service want.
 *
 * Eligibility-rule semantics: the row's `eligibility_rule` is authoritative.
 * The config block's `eligibility_defaults` is reserved for genuinely
 * cross-cutting filters and is NOT merged in by default — merging would
 * leak XP-board-specific rules (min_level, min_weekly_actions, …) onto
 * non-XP boards like lifetime_dex_completion. Each board's seed row carries
 * its own complete rule set; defaults stay available in config for future
 * cross-cutting needs (e.g. a global bot-exclusion flag).
 *
 * Anti-sniping window: the config-level default fills in only when the row
 * leaves it NULL. (Lifetime boards stay NULL — no anti-sniping for them.)
 */
function hydrate(row, leaderboardConfig) {
  if (!row) return null;
  return {
    id: row.id,
    leaderboardKey: row.leaderboard_key,
    scope: row.scope,
    metricType: row.metric_type,
    eligibilityRule: row.eligibility_rule || {},
    tieBreakRule: row.tie_break_rule,
    rewardEnabled: row.reward_enabled,
    periodDefinition: row.period_definition || null,
    antiSnipingWindowSeconds:
      row.anti_sniping_window_seconds
      ?? (row.scope === 'lifetime'
        ? null
        : leaderboardConfig.defaultAntiSnipingWindowSeconds),
    isActive: row.is_active,
    logicVersion: row.logic_version,
  };
}

/**
 * Returns the fully-resolved definition for `leaderboardKey`, or null if
 * not found / inactive.
 */
async function getDefinition(leaderboardKey, txOrPrisma = prisma) {
  const [rows, cfg] = await Promise.all([
    txOrPrisma.$queryRawUnsafe(
      `SELECT * FROM leaderboard_definitions
        WHERE leaderboard_key = $1 AND is_active = TRUE`,
      leaderboardKey
    ),
    loadLeaderboardConfig(txOrPrisma),
  ]);
  return hydrate(rows[0], cfg);
}

/**
 * Returns all active definitions, fully resolved.
 */
async function listActive(txOrPrisma = prisma) {
  const [rows, cfg] = await Promise.all([
    txOrPrisma.$queryRawUnsafe(
      `SELECT * FROM leaderboard_definitions
        WHERE is_active = TRUE
        ORDER BY id ASC`
    ),
    loadLeaderboardConfig(txOrPrisma),
  ]);
  return rows.map((r) => hydrate(r, cfg));
}

/**
 * Pure helper. Given a hydrated definition + current UTC instant, returns the
 * concrete period_key the worker should write to.
 *
 *   scope = 'lifetime'     →  'LIFETIME'   (constant)
 *   scope = 'weekly'       →  'YYYY-Www'   (UTC ISO week of nowUtc)
 *   scope = 'monthly'      →  not supported at MVP — throws to surface usage.
 */
function resolvePeriodKey(definition, nowUtc) {
  if (!definition) {
    throw new Error('resolvePeriodKey: definition is required');
  }
  if (definition.scope === 'lifetime') return LIFETIME_PERIOD_KEY;
  if (definition.scope === 'weekly')   return utcWeekKey(nowUtc);
  throw new Error(`resolvePeriodKey: scope "${definition.scope}" not supported at MVP`);
}

module.exports = {
  loadLeaderboardConfig,
  getDefinition,
  listActive,
  resolvePeriodKey,
  // exposed for testing
  hydrate,
};
