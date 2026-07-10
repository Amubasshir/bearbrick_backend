'use strict';

// Unit 3.1 — GET /api/admin/bounty-submissions (first admin endpoint; review
// queue). Establishes the admin pattern: adminAuth (transport) + requirePermission
// ('can_approve_images') (permission). Tests BOTH auth paths (admin JWT via
// createFreshAdmin, and X-Admin-Secret transport) and pins the option-2 layering.

const request = require('supertest');
const {
  app, ADMIN_SECRET, createFreshUser, createFreshAdmin, adminReq,
} = require('../helpers/dex');
const {
  prisma, createBrick, cleanup, instanceIdByType,
} = require('../services/bounties/helpers');
const Inst = require('../../src/services/bounties/BountyInstanceService');

const BASE = '/api/admin/bounty-submissions';

async function seedSubmission(brickId, instanceId, userId, { status = 'PENDING', createdAt } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bounty_submissions
       (bounty_instance_id, brick_id, user_id, submission_type, content_url,
        status, created_at, updated_at, cash_reward_cents, credit_reward, xp_reward)
     VALUES ($1::uuid, $2, $3, 'IMAGE', 'https://x/p.png', $4, $5::timestamptz, NOW(), 0, 0, 0)
     RETURNING id`,
    instanceId, brickId, BigInt(userId), status, createdAt
  );
  return rows[0].id;
}

let admin;      // createFreshAdmin
let plain;      // non-admin
let seedUserId; // owner of seeded submissions
let brickOrder;
let brickType;
let brickPage;
let instBackType;
let instYearType;
// ordering
let sPendOld;
let sPendNew;

beforeAll(async () => {
  admin = await createFreshAdmin('u31admin');
  plain = await createFreshUser('u31plain');
  seedUserId = plain.userId;

  // --- ordering brick: 2 PENDING (diff times) + APPROVED + REJECTED ---
  brickOrder = await createBrick({ tag: 'u31order' });
  let brick = await Inst.getBrickForGeneration(prisma, brickOrder);
  await Inst.generateForBrick(prisma, brick);
  const orderInst = await instanceIdByType(brickOrder, 'PACKAGING_BACK');
  await seedSubmission(brickOrder, orderInst, seedUserId, { status: 'APPROVED', createdAt: '2026-05-01T00:00:00Z' });
  sPendOld = await seedSubmission(brickOrder, orderInst, seedUserId, { status: 'PENDING', createdAt: '2026-05-02T00:00:00Z' });
  sPendNew = await seedSubmission(brickOrder, orderInst, seedUserId, { status: 'PENDING', createdAt: '2026-05-03T00:00:00Z' });
  await seedSubmission(brickOrder, orderInst, seedUserId, { status: 'REJECTED', createdAt: '2026-05-04T00:00:00Z' });

  // --- type brick: one PENDING per type ---
  brickType = await createBrick({ tag: 'u31type' });
  brick = await Inst.getBrickForGeneration(prisma, brickType);
  await Inst.generateForBrick(prisma, brick);
  instBackType = await instanceIdByType(brickType, 'PACKAGING_BACK');
  instYearType = await instanceIdByType(brickType, 'RELEASE_YEAR');
  await seedSubmission(brickType, instBackType, seedUserId, { status: 'PENDING', createdAt: '2026-05-05T00:00:00Z' });
  await seedSubmission(brickType, instYearType, seedUserId, { status: 'PENDING', createdAt: '2026-05-06T00:00:00Z' });

  // --- pagination brick: 51 PENDING ---
  brickPage = await createBrick({ tag: 'u31page' });
  brick = await Inst.getBrickForGeneration(prisma, brickPage);
  await Inst.generateForBrick(prisma, brick);
  const pageInst = await instanceIdByType(brickPage, 'PACKAGING_BACK');
  await prisma.$executeRawUnsafe(
    `INSERT INTO bounty_submissions
       (bounty_instance_id, brick_id, user_id, submission_type, content_url,
        status, created_at, updated_at, cash_reward_cents, credit_reward, xp_reward)
     SELECT $1::uuid, $2, $3, 'IMAGE', 'https://x/'||g||'.png', 'PENDING',
            TIMESTAMPTZ '2026-04-01 00:00:00' + (g || ' seconds')::interval, NOW(), 0, 0, 0
     FROM generate_series(1, 51) g`,
    pageInst, brickPage, BigInt(seedUserId)
  );
});

afterAll(cleanup);

function ids(res) {
  return res.body.data.submissions.map((s) => s.id);
}

describe('GET /api/admin/bounty-submissions — auth (both paths + option-2 layering)', () => {
  test('401 when unauthenticated', async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT', async () => {
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${plain.token}`);
    expect(res.status).toBe(403);
  });

  test('200 via admin JWT (hasPermission can_approve_images path)', async () => {
    const res = await request(app)
      .get(`${BASE}?brick_id=${brickOrder}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.submissions)).toBe(true);
  });

  test('200 via X-Admin-Secret (transport path)', async () => {
    const res = await adminReq().get(`${BASE}?brick_id=${brickOrder}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('LAYERING PIN: X-Admin-Secret succeeds with req.user=null — permission layer bypassed', async () => {
    // A null user would fail hasPermission; that this returns 200 proves the
    // secret path short-circuits BEFORE the permission check (guards option-2).
    const res = await request(app)
      .get(`${BASE}?brick_id=${brickOrder}`)
      .set('X-Admin-Secret', ADMIN_SECRET);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/admin/bounty-submissions — queue behavior', () => {
  test('only PENDING, oldest-first', async () => {
    const res = await adminReq().get(`${BASE}?brick_id=${brickOrder}`);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([sPendOld, sPendNew]); // APPROVED/REJECTED excluded
    expect(res.body.data.submissions.every((s) => s.status === 'PENDING')).toBe(true);
  });

  test('filters by bounty_type', async () => {
    const res = await adminReq().get(`${BASE}?brick_id=${brickType}&bounty_type=PACKAGING_BACK`);
    expect(res.status).toBe(200);
    expect(res.body.data.submissions).toHaveLength(1);
    expect(res.body.data.submissions[0].bountyType).toBe('PACKAGING_BACK');
  });

  test('filters by brick_id (scopes to that brick)', async () => {
    const res = await adminReq().get(`${BASE}?brick_id=${brickType}`);
    expect(res.status).toBe(200);
    expect(res.body.data.submissions).toHaveLength(2);
    expect(res.body.data.submissions.every((s) => s.brickId === brickType)).toBe(true);
  });

  test('paginates at 50 (page 1 = 50, page 2 = remainder)', async () => {
    const p1 = await adminReq().get(`${BASE}?brick_id=${brickPage}`);
    expect(p1.status).toBe(200);
    expect(p1.body.data.submissions).toHaveLength(50);

    const p2 = await adminReq().get(`${BASE}?brick_id=${brickPage}&page=2`);
    expect(p2.status).toBe(200);
    expect(p2.body.data.submissions).toHaveLength(1);
    // No overlap between pages.
    const p1ids = new Set(p1.body.data.submissions.map((s) => s.id));
    expect(p1ids.has(p2.body.data.submissions[0].id)).toBe(false);
  });
});
