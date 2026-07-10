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

// Whitelisted editable columns for PATCH (Unit 3.7). Grounded in the real
// bounty_definitions columns: reward amounts, priority (the tier that drives the
// derived XP — there is no xp column), and is_active (global pause-by-type, Q19).
// `type` and identity/timestamp columns are intentionally excluded — `type` keys
// the FIELD_MAP target-field derivation that manual + auto create depend on.
const EDITABLE_COLUMN_MAP = {
  rewardCashCents: 'reward_cash_cents',
  rewardCredits: 'reward_credits',
  priority: 'priority',
  isActive: 'is_active',
};

/**
 * Partial update of a bounty definition (Unit 3.7). `patch` holds only already-
 * validated editable fields (camelCase keys from EDITABLE_COLUMN_MAP); at least
 * one must be present (the controller guards the empty case). Writes only the
 * provided columns + updated_at. Returns the updated definition row, or null if
 * `id` matched no definition. This is forward-only: submission rows captured their
 * rewards at submission time and are never re-read from the definition, so an edit
 * here changes future submissions only.
 */
async function update(client, id, patch) {
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(EDITABLE_COLUMN_MAP)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) return undefined; // guarded by the controller
  params.push(id);
  const rows = await (client || prisma).$queryRawUnsafe(
    `UPDATE bounty_definitions SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length}::uuid
     RETURNING ${DEFINITION_COLUMNS}`,
    ...params
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
  update,
  getAdminSettings,
  DEFINITION_COLUMNS,
  EDITABLE_COLUMN_MAP,
  PRIORITY_ORDER,
};
