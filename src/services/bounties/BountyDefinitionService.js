'use strict';

// BountyDefinitionService — thin read layer over bounty_definitions and the
// admin_settings key/value table. All reads use raw SQL via the passed client
// (prisma or a tx), matching the established service pattern.

const prisma = require('../../lib/prisma');

const DEFINITION_COLUMNS =
  'id, type, display_name, description, reward_cash_cents, reward_credits, priority, is_active';

// HIGH first, then MEDIUM, then LOW (priority is TEXT so we order explicitly).
const PRIORITY_ORDER = `CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END`;

async function listActive(client = prisma) {
  return client.$queryRawUnsafe(
    `SELECT ${DEFINITION_COLUMNS} FROM bounty_definitions
     WHERE is_active = TRUE ORDER BY ${PRIORITY_ORDER}, type ASC`
  );
}

async function listAll(client = prisma) {
  return client.$queryRawUnsafe(
    `SELECT ${DEFINITION_COLUMNS} FROM bounty_definitions ORDER BY ${PRIORITY_ORDER}, type ASC`
  );
}

async function getByType(client, type) {
  const rows = await client.$queryRawUnsafe(
    `SELECT ${DEFINITION_COLUMNS} FROM bounty_definitions WHERE type = $1 LIMIT 1`,
    type
  );
  return rows[0] || null;
}

async function getById(client, id) {
  const rows = await client.$queryRawUnsafe(
    `SELECT ${DEFINITION_COLUMNS} FROM bounty_definitions WHERE id = $1::uuid LIMIT 1`,
    id
  );
  return rows[0] || null;
}

/**
 * Read the four MVP admin_settings keys (+ the reset marker) into a typed object.
 * Values are stored as TEXT; parsed here. Missing keys fall back to spec defaults.
 */
async function getAdminSettings(client = prisma) {
  const rows = await client.$queryRawUnsafe(`SELECT key, value FROM admin_settings`);
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    monthlyCashBudgetCents: parseInt(map.monthly_cash_budget_cents != null ? map.monthly_cash_budget_cents : '50000', 10),
    monthlyCashSpentCents: parseInt(map.monthly_cash_spent_cents != null ? map.monthly_cash_spent_cents : '0', 10),
    cashRewardsEnabled: (map.cash_rewards_enabled != null ? map.cash_rewards_enabled : 'true') === 'true',
    minimumPayoutCents: parseInt(map.minimum_payout_cents != null ? map.minimum_payout_cents : '1000', 10),
    monthlyBudgetLastResetPeriod: map.monthly_budget_last_reset_period != null ? map.monthly_budget_last_reset_period : '',
  };
}

module.exports = {
  listActive,
  listAll,
  getByType,
  getById,
  getAdminSettings,
  DEFINITION_COLUMNS,
};
