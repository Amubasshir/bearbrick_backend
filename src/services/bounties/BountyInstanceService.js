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
    const ins = await c.$queryRawUnsafe(
      `INSERT INTO bounty_instances
         (brick_id, bounty_definition_id, target_field, status, created_by)
       VALUES ($1, $2::uuid, $3, 'OPEN', 'SYSTEM')
       ON CONFLICT (brick_id, bounty_definition_id, target_field)
         WHERE status = 'OPEN' DO NOTHING
       RETURNING id`,
      brick.id, def.id, map.column
    );
    if (ins.length > 0) created += 1;
  }
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
  getBrickForGeneration,
  generateForBrick,
  closeFilledForBrick,
  closeInstanceIfFieldFilled,
  countOpenForBrick,
};
