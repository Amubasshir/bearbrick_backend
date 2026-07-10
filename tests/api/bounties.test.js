'use strict';

// Unit 1.1 — GET /api/bounties (public read of OPEN bounties).
// Supertest against the exported app. Seeds bounty_instances directly (with
// explicit created_at) so the priority-then-created_at sort is deterministic,
// and scopes filter/sort assertions to freshly-created bricks so the shared dev
// DB's pre-existing open bounties don't perturb them. Cleans up own rows.

const request = require('supertest');
const app = require('../../src/app');
const { prisma, createBrick, cleanup } = require('../services/bounties/helpers');
const { createFreshUser } = require('../helpers/dex');
const { FIELD_MAP } = require('../../src/services/bounties/bountyTypes');

// Fixed, ordered timestamps to prove the secondary created_at sort.
const T0 = '2026-06-01T00:00:00.000Z'; // oldest
const T1 = '2026-06-02T00:00:00.000Z';
const T2 = '2026-06-03T00:00:00.000Z'; // newest

async function defByType(type) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, type, priority, description, reward_cash_cents, reward_credits
       FROM bounty_definitions WHERE type = $1 LIMIT 1`,
    type
  );
  return rows[0];
}

async function brickName(brickId) {
  const rows = await prisma.$queryRawUnsafe(`SELECT name FROM bricks WHERE id = $1`, brickId);
  return rows[0].name;
}

// Insert a single OPEN instance for (brick, definition) with an explicit created_at.
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

let brickA;         // has 3 open bounties: 2 HIGH + 1 MEDIUM
let brickAName;
let brickB;         // has 0 open bounties
let frontDef;       // PACKAGING_FRONT — HIGH
let backDef;        // PACKAGING_BACK  — HIGH
let sideDef;        // SIDE_VIEW       — MEDIUM
let idFront;
let idBack;
let idSide;

beforeAll(async () => {
  frontDef = await defByType('PACKAGING_FRONT');
  backDef = await defByType('PACKAGING_BACK');
  sideDef = await defByType('SIDE_VIEW');

  brickA = await createBrick({ tag: 'u11a' });
  brickAName = await brickName(brickA);
  brickB = await createBrick({ tag: 'u11b' });

  // On brickA: MEDIUM is OLDEST (T0), HIGHs are newer (T1 < T2). This proves
  // priority dominates created_at, and created_at ASC breaks ties within HIGH.
  idSide = await addInstance(brickA, sideDef, T0);
  idFront = await addInstance(brickA, frontDef, T1);
  idBack = await addInstance(brickA, backDef, T2);
});

afterAll(cleanup);

function ids(body) {
  return body.data.bounties.map((b) => b.id);
}

describe('GET /api/bounties', () => {
  test('returns open bounties in the standard envelope; seeded instance present + shaped', async () => {
    const res = await request(app).get('/api/bounties');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.bounties)).toBe(true);

    const mine = res.body.data.bounties.find((b) => b.id === idFront);
    expect(mine).toBeDefined();
    expect(mine).toEqual({
      id: idFront,
      brickId: brickA,
      brickName: brickAName,
      size: null,
      type: 'PACKAGING_FRONT',
      description: frontDef.description ?? null,
      rewardCashCents: frontDef.reward_cash_cents,
      rewardCredits: frontDef.reward_credits,
      priority: 'HIGH',
      status: 'OPEN',
    });
  });

  test('sorts by priority then created_at ASC (scoped to one brick)', async () => {
    const res = await request(app).get(`/api/bounties?brick_id=${brickA}`);
    expect(res.status).toBe(200);
    // 2 HIGH (FRONT@T1 before BACK@T2) then 1 MEDIUM (SIDE@T0, oldest but last).
    expect(ids(res.body)).toEqual([idFront, idBack, idSide]);
  });

  test('filter: type narrows to the matching bounty', async () => {
    const res = await request(app).get(`/api/bounties?brick_id=${brickA}&type=SIDE_VIEW`);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([idSide]);
    expect(res.body.data.bounties[0].type).toBe('SIDE_VIEW');
  });

  test('filter: priority narrows to the matching bounties', async () => {
    const res = await request(app).get(`/api/bounties?brick_id=${brickA}&priority=HIGH`);
    expect(res.status).toBe(200);
    expect(ids(res.body).sort()).toEqual([idFront, idBack].sort());
    expect(res.body.data.bounties.every((b) => b.priority === 'HIGH')).toBe(true);
  });

  test('filter: reward_min excludes lower-reward bounties', async () => {
    // frontDef reward (HIGH) is above sideDef reward (MEDIUM); using it as the
    // floor keeps both HIGH bounties and drops the MEDIUM one.
    const floor = frontDef.reward_cash_cents;
    const res = await request(app).get(`/api/bounties?brick_id=${brickA}&reward_min=${floor}`);
    expect(res.status).toBe(200);
    const got = ids(res.body);
    expect(got).toContain(idFront);
    expect(got).toContain(idBack);
    expect(got).not.toContain(idSide);
    expect(res.body.data.bounties.every((b) => b.rewardCashCents >= floor)).toBe(true);
  });

  test('filter: brick_id scopes to that brick only', async () => {
    const res = await request(app).get(`/api/bounties?brick_id=${brickA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.bounties.every((b) => b.brickId === brickA)).toBe(true);
    expect(res.body.data.bounties).toHaveLength(3);
  });

  test('empty result is {success:true,data:{bounties:[]}}, not an error', async () => {
    const res = await request(app).get(`/api/bounties?brick_id=${brickB}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { bounties: [] } });
  });

  test('works for a guest (no auth header)', async () => {
    const res = await request(app).get(`/api/bounties?brick_id=${brickA}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('works for an authenticated caller too', async () => {
    const { token } = await createFreshUser('u11auth');
    const res = await request(app)
      .get(`/api/bounties?brick_id=${brickA}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([idFront, idBack, idSide]);
  });
});
