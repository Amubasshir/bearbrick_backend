'use strict';

// BountyInstanceService — auto-generation and closure of bounty_instances
// (spec §5). Operates per-brick; the A5 auto-bounty-generator worker iterates
// bricks and calls these. Respects bounty_definitions.is_active so a globally
// paused type (Q19) is never generated.
//
// Idempotency: generation relies on the `unique_open_bounty` partial unique
// index (at most one OPEN instance per brick+definition+field) via ON CONFLICT.

const prisma = require('../../lib/prisma');
const { FIELD_MAP } = require('./bountyTypes');
const { PRIORITY_ORDER, getByType } = require('./BountyDefinitionService');

class InstanceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'InstanceError';
    this.code = code;
  }
}

// Columns returned when a full instance row is needed (manual create / shaping).
const INSTANCE_SELECT = `
  id, brick_id, bounty_definition_id, target_field, status,
  created_by, closed_at, created_at, updated_at`;

/**
 * Insert one OPEN instance for (brickId, definitionId, targetField), idempotent
 * via the unique_open_bounty partial index (ON CONFLICT DO NOTHING). Returns the
 * created row, or null if an OPEN instance already existed (the race-free
 * duplicate signal). Shared by both the auto-generator and manual create so the
 * insert path — including the ON CONFLICT clause — is defined exactly once.
 */
async function insertOpenInstance(c, { brickId, definitionId, targetField, createdBy = 'SYSTEM' }) {
  const rows = await c.$queryRawUnsafe(
    `INSERT INTO bounty_instances
       (brick_id, bounty_definition_id, target_field, status, created_by)
     VALUES ($1, $2::uuid, $3, 'OPEN', $4)
     ON CONFLICT (brick_id, bounty_definition_id, target_field)
       WHERE status = 'OPEN' DO NOTHING
     RETURNING ${INSTANCE_SELECT}`,
    brickId, definitionId, targetField, createdBy
  );
  return rows[0] || null;
}

// Selects a brick row with exactly the columns the generator inspects.
const BRICK_SELECT = `
  id,
  packaging_front_image_url, packaging_back_image_url, back_image_url,
  side_image_url, bottom_stamp_image_url, release_year, release_method, notes`;

async function getBrickForGeneration(client, brickId) {
  const rows = await (client || prisma).$queryRawUnsafe(
    `SELECT ${BRICK_SELECT} FROM bricks WHERE id = $1 LIMIT 1`,
    brickId
  );
  return rows[0] || null;
}

/**
 * For each active definition whose target field is null on `brick`, insert an
 * OPEN instance. Idempotent via the partial unique index. Returns the count of
 * instances actually created.
 * `brick` is a row selected with BRICK_SELECT (snake_case keys).
 */
async function generateForBrick(client, brick) {
  const c = client || prisma;
  const defs = await c.$queryRawUnsafe(
    `SELECT id, type FROM bounty_definitions WHERE is_active = TRUE`
  );
  let created = 0;
  for (const def of defs) {
    const map = FIELD_MAP[def.type];
    if (!map) continue;
    const value = brick[map.column];
    if (value !== null && value !== undefined) continue; // field already filled
    // eslint-disable-next-line no-await-in-loop
    const ins = await insertOpenInstance(c, {
      brickId: brick.id, definitionId: def.id, targetField: map.column,
    });
    if (ins) created += 1;
  }
  return created;
}

/**
 * Manually create one OPEN bounty for a brick + bounty type (spec §18.2, admin
 * POST /api/admin/bounties). Reuses getByType + the FIELD_MAP target-field
 * derivation the auto-generator uses (never a parallel mapping) and the shared
 * insertOpenInstance. Throws InstanceError:
 *   brick_not_found      — no such brick
 *   definition_not_found — no definition for `type`
 *   definition_inactive  — the type exists but is globally paused (is_active=false)
 *   invalid_bounty_type  — type has no FIELD_MAP column (defensive)
 *   duplicate_open_bounty— an OPEN bounty for this brick+field already exists
 * Returns the created instance row (INSTANCE_SELECT columns).
 */
async function createManual(client, { brickId, type, createdBy = 'ADMIN' }) {
  const c = client || prisma;
  const brickRows = await c.$queryRawUnsafe(`SELECT id FROM bricks WHERE id = $1 LIMIT 1`, brickId);
  if (!brickRows[0]) throw new InstanceError('brick_not_found');

  const def = await getByType(c, type);
  if (!def) throw new InstanceError('definition_not_found');
  if (!def.is_active) throw new InstanceError('definition_inactive');

  const map = FIELD_MAP[type];
  if (!map) throw new InstanceError('invalid_bounty_type');

  const created = await insertOpenInstance(c, {
    brickId, definitionId: def.id, targetField: map.column, createdBy,
  });
  if (!created) throw new InstanceError('duplicate_open_bounty');
  return created;
}

/**
 * Close any OPEN instance on `brick` whose target field is now non-null (Q13 —
 * auto-close when a field is filled directly or via approve-and-apply). Returns
 * the count closed.
 */
async function closeFilledForBrick(client, brick) {
  const c = client || prisma;
  const open = await c.$queryRawUnsafe(
    `SELECT id, target_field FROM bounty_instances
     WHERE brick_id = $1 AND status = 'OPEN'`,
    brick.id
  );
  let closed = 0;
  for (const inst of open) {
    const value = brick[inst.target_field];
    if (value === null || value === undefined) continue;
    // eslint-disable-next-line no-await-in-loop
    const upd = await c.$queryRawUnsafe(
      `UPDATE bounty_instances
         SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'OPEN'
       RETURNING id`,
      inst.id
    );
    if (upd.length > 0) closed += 1;
  }
  return closed;
}

/**
 * Close a single instance if its brick's target field is now filled. Used by
 * approve-and-apply (A4). Returns { closed, brickId, targetField }.
 */
async function closeInstanceIfFieldFilled(client, bountyInstanceId) {
  const c = client || prisma;
  const rows = await c.$queryRawUnsafe(
    `SELECT bi.id, bi.brick_id, bi.target_field, bi.status
     FROM bounty_instances bi WHERE bi.id = $1::uuid LIMIT 1`,
    bountyInstanceId
  );
  const inst = rows[0];
  if (!inst || inst.status !== 'OPEN') {
    return { closed: false, brickId: inst ? inst.brick_id : null, targetField: inst ? inst.target_field : null };
  }
  const brick = await getBrickForGeneration(c, inst.brick_id);
  const filled = brick && brick[inst.target_field] !== null && brick[inst.target_field] !== undefined;
  if (!filled) {
    return { closed: false, brickId: inst.brick_id, targetField: inst.target_field };
  }
  const upd = await c.$queryRawUnsafe(
    `UPDATE bounty_instances
       SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid AND status = 'OPEN' RETURNING id`,
    bountyInstanceId
  );
  return { closed: upd.length > 0, brickId: inst.brick_id, targetField: inst.target_field };
}

/**
 * List bounty instances for the public GET /api/bounties feed (spec §18.1).
 * Joins the definition (type, description, reward, priority) and the brick
 * (name). Defaults to OPEN; all filters optional. Reward comes from the current
 * definition (instances carry no reward; capture-at-submission is a separate
 * concern). Sorted priority-first (HIGH>MEDIUM>LOW) then created_at ascending.
 *
 * filters: { type, priority, brickId, rewardMin, status }
 */
async function listOpen(filters = {}, client = prisma) {
  const { type, priority, brickId, rewardMin, status } = filters;
  const params = [];
  const where = [];

  params.push(status || 'OPEN');
  where.push(`bi.status = $${params.length}`);
  if (type) { params.push(type); where.push(`bd.type = $${params.length}`); }
  if (priority) { params.push(priority); where.push(`bd.priority = $${params.length}`); }
  if (brickId) { params.push(brickId); where.push(`bi.brick_id = $${params.length}`); }
  if (rewardMin != null) { params.push(rewardMin); where.push(`bd.reward_cash_cents >= $${params.length}`); }

  return client.$queryRawUnsafe(
    `SELECT bi.id, bi.brick_id, bi.status, bi.created_at,
            b.name AS brick_name,
            bd.type, bd.description, bd.reward_cash_cents, bd.reward_credits, bd.priority
     FROM bounty_instances bi
     JOIN bounty_definitions bd ON bd.id = bi.bounty_definition_id
     JOIN bricks b ON b.id = bi.brick_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${PRIORITY_ORDER}, bi.created_at ASC`,
    ...params
  );
}

// Instance status state machine (Unit 3.8). Values grounded in the CHECK
// constraint (OPEN|PAUSED|CLOSED). Allowed targets per current status; X->X is an
// idempotent no-op. CLOSED->PAUSED is the one illegal transition.
const STATUS_VALUES = new Set(['OPEN', 'PAUSED', 'CLOSED']);
const ALLOWED_TRANSITIONS = {
  OPEN: new Set(['OPEN', 'PAUSED', 'CLOSED']),
  PAUSED: new Set(['PAUSED', 'OPEN', 'CLOSED']),
  CLOSED: new Set(['CLOSED', 'OPEN']),
};

// Detect a unique_open_bounty (partial index) violation surfaced by a raw UPDATE.
// Prisma 7 wraps a raw-query Postgres error; the PG code (23505), the constraint
// name, or the standard duplicate-key message can appear in err, err.code,
// err.meta.code, or err.meta.message — check them all.
function isUniqueOpenViolation(err) {
  if (!err) return false;
  const parts = [err.code, err.message];
  if (err.meta) parts.push(err.meta.code, err.meta.message);
  const blob = parts.filter(Boolean).map(String).join(' ');
  return /23505/.test(blob) || /unique_open_bounty/i.test(blob) || /duplicate key value/i.test(blob);
}

/**
 * Transition one instance to targetStatus (pause/close/reopen), spec §18.2 admin
 * PATCH /api/admin/bounty-instances/:id. State machine (OPEN|PAUSED|CLOSED):
 *   pause  OPEN->PAUSED
 *   close  OPEN|PAUSED->CLOSED    (sets closed_at)
 *   reopen CLOSED|PAUSED->OPEN    (clears closed_at)
 *   X->X   idempotent no-op
 *   CLOSED->PAUSED illegal
 * Reopen (->OPEN) can collide with the unique_open_bounty partial index if another
 * OPEN instance already covers this brick+field — the DB index arbitrates (no
 * check-then-update) and the violation maps to duplicate_open_bounty (409).
 * Throws InstanceError: instance_not_found | illegal_transition | duplicate_open_bounty.
 * Returns the (updated) instance row (INSTANCE_SELECT).
 */
async function transition(client, instanceId, targetStatus) {
  const c = client || prisma;
  const rows = await c.$queryRawUnsafe(
    `SELECT ${INSTANCE_SELECT} FROM bounty_instances WHERE id = $1::uuid LIMIT 1`,
    instanceId
  );
  const inst = rows[0];
  if (!inst) throw new InstanceError('instance_not_found');

  const allowed = ALLOWED_TRANSITIONS[inst.status];
  if (!allowed || !allowed.has(targetStatus)) throw new InstanceError('illegal_transition');
  if (inst.status === targetStatus) return inst; // idempotent no-op

  // closed_at: set on close, cleared on reopen, untouched on pause.
  let closedAtSql = 'closed_at';
  if (targetStatus === 'CLOSED') closedAtSql = 'NOW()';
  else if (targetStatus === 'OPEN') closedAtSql = 'NULL';

  try {
    const upd = await c.$queryRawUnsafe(
      `UPDATE bounty_instances
         SET status = $2, closed_at = ${closedAtSql}, updated_at = NOW()
       WHERE id = $1::uuid
       RETURNING ${INSTANCE_SELECT}`,
      instanceId, targetStatus
    );
    return upd[0];
  } catch (err) {
    if (targetStatus === 'OPEN' && isUniqueOpenViolation(err)) {
      throw new InstanceError('duplicate_open_bounty');
    }
    throw err;
  }
}

/**
 * Number of OPEN bounties remaining on a brick. Used by approve-and-apply to
 * decide BRICK_COMPLETED (Q7).
 */
async function countOpenForBrick(client, brickId) {
  const r = await (client || prisma).$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM bounty_instances WHERE brick_id = $1 AND status = 'OPEN'`,
    brickId
  );
  return r[0].c;
}

module.exports = {
  BRICK_SELECT,
  INSTANCE_SELECT,
  STATUS_VALUES,
  getBrickForGeneration,
  generateForBrick,
  createManual,
  transition,
  closeFilledForBrick,
  closeInstanceIfFieldFilled,
  countOpenForBrick,
  listOpen,
  InstanceError,
};
