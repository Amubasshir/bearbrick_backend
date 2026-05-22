'use strict';

// Thin read layer over challenge_templates + xp_config_versions challenge
// config. Used by PoolBuilderService (daily) and ChallengeAssignmentService
// (weekly + per-user filtering). No writes here — templates are seeded via
// migration, not at runtime.

const prisma = require('../../lib/prisma');

/**
 * Load the latest active challenge config from xp_config_versions:
 *   { daily_assignment_count, weekly_assignment_count, max_session_overlap,
 *     daily_pool_family_mix, weekly_slate_mix }
 *
 * Falls back to spec-defaults if the v3 config is somehow missing keys.
 */
async function loadChallengeConfig(prismaClient = prisma) {
  const rows = await prismaClient.$queryRawUnsafe(
    `SELECT config FROM xp_config_versions WHERE is_active = TRUE
       ORDER BY version DESC LIMIT 1`
  );
  const cfg = rows[0]?.config?.challenges || {};
  return {
    dailyAssignmentCount: cfg.daily_assignment_count ?? 5,
    weeklyAssignmentCount: cfg.weekly_assignment_count ?? 3,
    maxSessionOverlap: cfg.max_session_overlap ?? 2,
    dailyPoolFamilyMix: cfg.daily_pool_family_mix || {
      vote_1: 'vote', vote_2: 'vote', explore: 'explore', maintain: 'maintain',
      category_mastery: 'category_mastery', contribute: 'contribute', wildcard: '*',
    },
    weeklySlateMix: cfg.weekly_slate_mix || {
      maintenance: 'maintain', exploration: 'explore', wildcard: '*',
    },
  };
}

/**
 * Return all active templates of a given scope ('daily' | 'weekly'), optionally
 * filtered by family. Family value '*' (wildcard) matches any family.
 */
async function listActive(scope, family, txOrPrisma = prisma) {
  if (family && family !== '*') {
    return txOrPrisma.$queryRawUnsafe(
      `SELECT * FROM challenge_templates
        WHERE is_active = TRUE AND scope = $1::"ChallengeScope" AND challenge_family = $2::"ChallengeFamily"`,
      scope, family
    );
  }
  return txOrPrisma.$queryRawUnsafe(
    `SELECT * FROM challenge_templates
      WHERE is_active = TRUE AND scope = $1::"ChallengeScope"`,
    scope
  );
}

/**
 * Look up a single template by integer id, or null if missing/inactive.
 */
async function findActiveById(id, txOrPrisma = prisma) {
  const rows = await txOrPrisma.$queryRawUnsafe(
    `SELECT * FROM challenge_templates WHERE id = $1 AND is_active = TRUE`,
    BigInt(id)
  );
  return rows[0] || null;
}

module.exports = {
  loadChallengeConfig,
  listActive,
  findActiveById,
};
