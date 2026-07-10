'use strict';

// Unit 3.8 — PATCH /api/admin/bounty-instances/:id (pause / close / reopen a
// specific instance; flag can_edit_bricks). Request shape {status} (direct target
// status). State machine grounded in the CHECK constraint (OPEN|PAUSED|CLOSED):
//   pause  OPEN->PAUSED
//   close  OPEN|PAUSED->CLOSED   (sets closed_at)
//   reopen CLOSED|PAUSED->OPEN   (clears closed_at)
//   X->X   idempotent no-op (200)
//   CLOSED->PAUSED illegal (422)
// The defining edge: reopening (->OPEN) can collide with the unique_open_bounty
// partial index if another OPEN instance already covers the same brick+field —
// the DB index arbitrates -> 409.

const request = require('supertest');
const { app, createFreshAdmin, createFreshUser, adminReq } = require('../helpers/dex');
const { prisma, createBrick, cleanup } = require('../services/bounties/helpers');

const url = (id) => `/api/admin/bounty-instances/${id}`;
const DUMMY_UUID = '11111111-1111-4111-8111-999999999999';
const FIELD = 'packaging_back_image_url';

let admin;
let plain;
let packDefId;

async function seedInstance(brickId, status, { field = FIELD, defId = packDefId } = {}) {
  const closedAt = status === 'CLOSED' ? 'NOW()' : 'NULL';
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bounty_instances
       (brick_id, bounty_definition_id, target_field, status, created_by, closed_at)
     VALUES ($1, $2::uuid, $3, $4, 'TEST', ${closedAt}) RETURNING id`,
    brickId, defId, field, status
  );
  return rows[0].id;
}

async function instRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, closed_at FROM bounty_instances WHERE id = $1::uuid`, id);
  return rows[0];
}

beforeAll(async () => {
  admin = await createFreshAdmin('u38admin');
  plain = await createFreshUser('u38plain');
  const defs = await prisma.$queryRawUnsafe(
    `SELECT id FROM bounty_definitions WHERE type = 'PACKAGING_BACK' LIMIT 1`);
  packDefId = defs[0].id;
});

afterAll(cleanup);

describe('PATCH /api/admin/bounty-instances/:id — auth (both paths)', () => {
  test('401 when unauthenticated', async () => {
    const brickId = await createBrick({ tag: 'u38a1' });
    const id = await seedInstance(brickId, 'OPEN');
    const res = await request(app).patch(url(id)).send({ status: 'PAUSED' });
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT (through requirePermission can_edit_bricks)', async () => {
    const brickId = await createBrick({ tag: 'u38a2' });
    const id = await seedInstance(brickId, 'OPEN');
    const res = await request(app).patch(url(id))
      .set('Authorization', `Bearer ${plain.token}`).send({ status: 'PAUSED' });
    expect(res.status).toBe(403);
  });

  test('200 via admin JWT (hasPermission path)', async () => {
    const brickId = await createBrick({ tag: 'u38a3' });
    const id = await seedInstance(brickId, 'OPEN');
    const res = await request(app).patch(url(id))
      .set('Authorization', `Bearer ${admin.token}`).send({ status: 'PAUSED' });
    expect(res.status).toBe(200);
    expect(res.body.data.instance.status).toBe('PAUSED');
  });

  test('200 via X-Admin-Secret (transport path)', async () => {
    const brickId = await createBrick({ tag: 'u38a4' });
    const id = await seedInstance(brickId, 'OPEN');
    const res = await adminReq().patch(url(id)).send({ status: 'CLOSED' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('PATCH /api/admin/bounty-instances/:id — transitions', () => {
  test('pause: OPEN -> PAUSED', async () => {
    const brickId = await createBrick({ tag: 'u38pause' });
    const id = await seedInstance(brickId, 'OPEN');
    const res = await adminReq().patch(url(id)).send({ status: 'PAUSED' });
    expect(res.status).toBe(200);
    expect(res.body.data.instance.status).toBe('PAUSED');
    expect((await instRow(id)).status).toBe('PAUSED');
  });

  test('close: OPEN -> CLOSED sets closed_at', async () => {
    const brickId = await createBrick({ tag: 'u38closeO' });
    const id = await seedInstance(brickId, 'OPEN');
    const res = await adminReq().patch(url(id)).send({ status: 'CLOSED' });
    expect(res.status).toBe(200);
    expect(res.body.data.instance.status).toBe('CLOSED');
    const row = await instRow(id);
    expect(row.status).toBe('CLOSED');
    expect(row.closed_at).not.toBeNull();
  });

  test('close: PAUSED -> CLOSED', async () => {
    const brickId = await createBrick({ tag: 'u38closeP' });
    const id = await seedInstance(brickId, 'PAUSED');
    const res = await adminReq().patch(url(id)).send({ status: 'CLOSED' });
    expect(res.status).toBe(200);
    expect((await instRow(id)).status).toBe('CLOSED');
  });

  test('reopen: CLOSED -> OPEN (no collision) clears closed_at', async () => {
    const brickId = await createBrick({ tag: 'u38reopenC' });
    const id = await seedInstance(brickId, 'CLOSED');
    expect((await instRow(id)).closed_at).not.toBeNull();
    const res = await adminReq().patch(url(id)).send({ status: 'OPEN' });
    expect(res.status).toBe(200);
    expect(res.body.data.instance.status).toBe('OPEN');
    const row = await instRow(id);
    expect(row.status).toBe('OPEN');
    expect(row.closed_at).toBeNull();
  });

  test('reopen: PAUSED -> OPEN', async () => {
    const brickId = await createBrick({ tag: 'u38reopenP' });
    const id = await seedInstance(brickId, 'PAUSED');
    const res = await adminReq().patch(url(id)).send({ status: 'OPEN' });
    expect(res.status).toBe(200);
    expect((await instRow(id)).status).toBe('OPEN');
  });

  test('same-state no-op: OPEN -> OPEN is an idempotent 200', async () => {
    const brickId = await createBrick({ tag: 'u38noop' });
    const id = await seedInstance(brickId, 'OPEN');
    const res = await adminReq().patch(url(id)).send({ status: 'OPEN' });
    expect(res.status).toBe(200);
    expect(res.body.data.instance.status).toBe('OPEN');
  });
});

describe('PATCH /api/admin/bounty-instances/:id — hazards & validation', () => {
  test('reopen collision: another OPEN for the same brick+field -> 409 (DB index arbitrates)', async () => {
    const brickId = await createBrick({ tag: 'u38collide' });
    const closedId = await seedInstance(brickId, 'CLOSED'); // same brick+def+field
    const openId = await seedInstance(brickId, 'OPEN');     // the live OPEN one
    const res = await adminReq().patch(url(closedId)).send({ status: 'OPEN' });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    // The blocked instance is unchanged; the existing OPEN is untouched.
    expect((await instRow(closedId)).status).toBe('CLOSED');
    expect((await instRow(openId)).status).toBe('OPEN');
  });

  test('instance not found -> 404', async () => {
    const res = await adminReq().patch(url(DUMMY_UUID)).send({ status: 'PAUSED' });
    expect(res.status).toBe(404);
  });

  test('illegal transition CLOSED -> PAUSED -> 422', async () => {
    const brickId = await createBrick({ tag: 'u38illegal' });
    const id = await seedInstance(brickId, 'CLOSED');
    const res = await adminReq().patch(url(id)).send({ status: 'PAUSED' });
    expect(res.status).toBe(422);
    expect((await instRow(id)).status).toBe('CLOSED'); // unchanged
  });

  test('bad status value -> 422', async () => {
    const brickId = await createBrick({ tag: 'u38badstatus' });
    const id = await seedInstance(brickId, 'OPEN');
    const res = await adminReq().patch(url(id)).send({ status: 'URGENT' });
    expect(res.status).toBe(422);
    expect(res.body.errors.status).toBeDefined();
  });

  test('missing status -> 422', async () => {
    const brickId = await createBrick({ tag: 'u38nostatus' });
    const id = await seedInstance(brickId, 'OPEN');
    const res = await adminReq().patch(url(id)).send({});
    expect(res.status).toBe(422);
    expect(res.body.errors.status).toBeDefined();
  });
});
