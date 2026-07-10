'use strict';

// Unit 1.2 — GET /api/bricks/:brickId/bounties (public read, one brick's OPEN
// bounties). Reuses BountyInstanceService.listOpen scoped by the path brickId.
// Seeds two bricks so path-scoping is provable; cleans up own rows.

const request = require('supertest');
const app = require('../../src/app');
const { prisma, createBrick, cleanup } = require('../services/bounties/helpers');
const { createFreshUser } = require('../helpers/dex');
const { FIELD_MAP } = require('../../src/services/bounties/bountyTypes');

const T1 = '2026-06-02T00:00:00.000Z';
const T2 = '2026-06-03T00:00:00.000Z';

async function defByType(type) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, type, priority, description, reward_cash_cents, reward_credits
       FROM bounty_definitions WHERE type = $1 LIMIT 1`,
    type
  );
  return rows[0];
}

async function addInstance(brickId, def, createdAt) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bounty_instances
       (brick_id, bounty_definition_id, target_field, status, created_by, created_at, updated_at)
     VALUES ($1, $2::uuid, $3, 'OPEN', 'SYSTEM', $4::timestamptz, $4::timestamptz)
     RETURNING id`,
    brickId, def.id, FIELD_MAP[def.type].column, createdAt
  );
  return rows[0].id;
}

let brickA;       // 2 open bounties (HIGH front, MEDIUM side)
let brickB;       // 1 open bounty (HIGH front) — must never appear under brickA
let brickEmpty;   // no open bounties
let frontDef;     // PACKAGING_FRONT — HIGH
let sideDef;      // SIDE_VIEW — MEDIUM
let aFront;
let aSide;
let bFront;

beforeAll(async () => {
  frontDef = await defByType('PACKAGING_FRONT');
  sideDef = await defByType('SIDE_VIEW');

  brickA = await createBrick({ tag: 'u12a' });
  brickB = await createBrick({ tag: 'u12b' });
  brickEmpty = await createBrick({ tag: 'u12e' });

  aFront = await addInstance(brickA, frontDef, T1);
  aSide = await addInstance(brickA, sideDef, T2);
  bFront = await addInstance(brickB, frontDef, T1);
});

afterAll(cleanup);

function ids(body) {
  return body.data.bounties.map((b) => b.id);
}

describe('GET /api/bricks/:brickId/bounties', () => {
  test("returns only the target brick's open bounties, in the standard envelope", async () => {
    const res = await request(app).get(`/api/bricks/${brickA}/bounties`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.bounties)).toBe(true);
    // brickA's two, HIGH before MEDIUM; brickB's bounty excluded.
    expect(ids(res.body)).toEqual([aFront, aSide]);
    expect(ids(res.body)).not.toContain(bFront);
    expect(res.body.data.bounties.every((b) => b.brickId === brickA)).toBe(true);
  });

  test('item shape matches 1.1 (camelCase fields, size null)', async () => {
    const res = await request(app).get(`/api/bricks/${brickA}/bounties?type=PACKAGING_FRONT`);
    expect(res.status).toBe(200);
    expect(res.body.data.bounties[0]).toEqual({
      id: aFront,
      brickId: brickA,
      brickName: expect.any(String),
      size: null,
      type: 'PACKAGING_FRONT',
      description: frontDef.description ?? null,
      rewardCashCents: frontDef.reward_cash_cents,
      rewardCredits: frontDef.reward_credits,
      priority: 'HIGH',
      status: 'OPEN',
    });
  });

  test('query filter composes with the path brick (type narrows within brick)', async () => {
    const res = await request(app).get(`/api/bricks/${brickA}/bounties?type=SIDE_VIEW`);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([aSide]);
    expect(res.body.data.bounties[0].type).toBe('SIDE_VIEW');
  });

  test('brick with no open bounties returns empty list', async () => {
    const res = await request(app).get(`/api/bricks/${brickEmpty}/bounties`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { bounties: [] } });
  });

  test('unknown brickId returns empty-list 200, not 404', async () => {
    const res = await request(app).get('/api/bricks/does-not-exist-xyz/bounties');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { bounties: [] } });
  });

  test('works for a guest (no auth header)', async () => {
    const res = await request(app).get(`/api/bricks/${brickA}/bounties`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('works for an authenticated caller too', async () => {
    const { token } = await createFreshUser('u12auth');
    const res = await request(app)
      .get(`/api/bricks/${brickA}/bounties`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([aFront, aSide]);
  });
});
