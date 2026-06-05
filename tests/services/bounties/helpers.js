'use strict';

// Shared DB helpers for the A3 bounty service integration tests. Tracks every
// row created so afterAll(cleanup) can remove it — the dev DB is shared and
// long-lived, so leaving rows behind would feed the documented accumulation
// flakes. Not a *.test.js file, so jest does not execute it directly.

const prisma = require('../../../src/lib/prisma');

const created = { userIds: [], brickIds: [] };

async function createUser({ verified = true, accountState = 'active', tz = 'UTC', tag = 'a3' } = {}) {
  const handle = `m4_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "User"
       (name, email, password, email_verified_at, account_state, timezone, "createdAt", "updatedAt")
     VALUES ($1, $2, 'x', ${verified ? 'NOW()' : 'NULL'}, $3::"AccountState", $4, NOW(), NOW())
     RETURNING id`,
    handle, `${handle}@m4.test`, accountState, tz
  );
  const id = BigInt(rows[0].id);
  created.userIds.push(id);
  return id;
}

// fields: snake_case bounty-column -> value to set non-null (others stay null).
async function createBrick({ fields = {}, tag = 'a3' } = {}) {
  const setCols = Object.keys(fields);
  const vals = setCols.map((c) => fields[c]);
  const colList = setCols.length ? ', ' + setCols.join(', ') : '';
  const valuesClause = setCols.length
    ? ', ' + setCols.map((_, idx) => `$${idx + 4}`).join(', ')
    : '';
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bricks (id, name, description_short, status, created_at, updated_at${colList})
     VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), NOW()${valuesClause})
     RETURNING id`,
    `Brick ${tag} ${Date.now()}_${Math.floor(Math.random() * 1e6)}`, 'desc', 'PUBLISHED', ...vals
  );
  const id = rows[0].id;
  created.brickIds.push(id);
  return id;
}

async function cleanup() {
  const uids = created.userIds.map(String);
  const bids = created.brickIds;
  // Child rows are deleted before their parents (every FK here is ON DELETE
  // RESTRICT). Order: payout audit -> payouts -> reward ledger -> submissions ->
  // instances -> stats/balances -> xp keys -> xp events -> bricks -> users.
  if (uids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM payout_action_events
        WHERE payout_request_id IN (SELECT id FROM payout_requests WHERE user_id = ANY($1::bigint[]))
           OR actor_user_id = ANY($1::bigint[])`,
      uids
    );
    await prisma.$executeRawUnsafe(`DELETE FROM payout_requests WHERE user_id = ANY($1::bigint[])`, uids);
    await prisma.$executeRawUnsafe(
      `DELETE FROM bounty_reward_events WHERE user_id = ANY($1::bigint[]) OR created_by = ANY($1::bigint[])`,
      uids
    );
  }
  if (uids.length || bids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM bounty_submissions WHERE user_id = ANY($1::bigint[]) OR brick_id = ANY($2::text[])`,
      uids, bids
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM bounty_instances WHERE brick_id = ANY($1::text[])`,
      bids
    );
  }
  if (uids.length) {
    await prisma.$executeRawUnsafe(`DELETE FROM user_bounty_stats WHERE user_id = ANY($1::bigint[])`, uids);
    await prisma.$executeRawUnsafe(`DELETE FROM user_balances WHERE user_id = ANY($1::bigint[])`, uids);
    await prisma.$executeRawUnsafe(`DELETE FROM xp_idempotency_keys WHERE user_id = ANY($1::bigint[])`, uids);
    await prisma.$executeRawUnsafe(`DELETE FROM xp_events WHERE user_id = ANY($1::bigint[])`, uids);
    await prisma.$executeRawUnsafe(`DELETE FROM user_identity_state WHERE user_id = ANY($1::bigint[])`, uids);
  }
  if (bids.length) {
    await prisma.$executeRawUnsafe(`DELETE FROM bricks WHERE id = ANY($1::text[])`, bids);
  }
  if (uids.length) {
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = ANY($1::bigint[])`, uids);
  }
  created.userIds.length = 0;
  created.brickIds.length = 0;
}

// admin_settings is a single global key/value table shared by every test. The
// A4 money tests mutate it (monthly_cash_spent_cents, budget), so they snapshot
// it before and restore after to leave zero net effect on the shared dev DB.
const ADMIN_KEYS = [
  'monthly_cash_budget_cents', 'monthly_cash_spent_cents',
  'cash_rewards_enabled', 'minimum_payout_cents', 'monthly_budget_last_reset_period',
];

async function snapshotAdminSettings() {
  const rows = await prisma.$queryRawUnsafe(`SELECT key, value FROM admin_settings`);
  const snap = {};
  for (const r of rows) snap[r.key] = r.value;
  return snap;
}

async function setAdminSetting(key, value) {
  await prisma.$executeRawUnsafe(
    `UPDATE admin_settings SET value = $2, updated_at = NOW() WHERE key = $1`,
    key, String(value)
  );
}

async function restoreAdminSettings(snap) {
  for (const key of ADMIN_KEYS) {
    if (snap[key] !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      await setAdminSetting(key, snap[key]);
    }
  }
}

async function balanceFor(userId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM user_balances WHERE user_id = $1`, BigInt(userId)
  );
  return rows[0] || null;
}

async function rewardEventsFor(userId) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM bounty_reward_events WHERE user_id = $1 ORDER BY created_at`, BigInt(userId)
  );
}

async function xpEventsFor(userId) {
  return prisma.$queryRawUnsafe(
    `SELECT event_type, xp_amount, reason FROM xp_events WHERE user_id = $1 ORDER BY id`, BigInt(userId)
  );
}

async function payoutsFor(userId) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM payout_requests WHERE user_id = $1 ORDER BY created_at`, BigInt(userId)
  );
}

async function payoutActionsFor(payoutRequestId) {
  return prisma.$queryRawUnsafe(
    `SELECT action, idempotency_key FROM payout_action_events WHERE payout_request_id = $1::uuid ORDER BY created_at`,
    payoutRequestId
  );
}

// Seed a user_balances row with a known cash balance (test setup for payouts).
async function seedBalance(userId, { cash = 0, reserved = 0, credits = 0 } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_balances (user_id, cash_balance_cents, reserved_cash_cents, credit_balance)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       cash_balance_cents = $2, reserved_cash_cents = $3, credit_balance = $4, updated_at = NOW()`,
    BigInt(userId), cash, reserved, credits
  );
}

async function instanceIdByType(brickId, type) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT bi.id FROM bounty_instances bi
     JOIN bounty_definitions bd ON bd.id = bi.bounty_definition_id
     WHERE bi.brick_id = $1 AND bd.type = $2 LIMIT 1`,
    brickId, type
  );
  return rows[0] ? rows[0].id : null;
}

async function statsFor(userId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM user_bounty_stats WHERE user_id = $1`,
    BigInt(userId)
  );
  return rows[0] || null;
}

module.exports = {
  prisma, created, createUser, createBrick, cleanup, instanceIdByType, statsFor,
  snapshotAdminSettings, restoreAdminSettings, setAdminSetting,
  balanceFor, rewardEventsFor, xpEventsFor, payoutsFor, payoutActionsFor, seedBalance,
};
