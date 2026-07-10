'use strict';

// Unit 3.9 — GET /api/admin/payout-requests (admin payout queue; flag
// can_manage_settings). Cross-user (NOT caller-scoped), filterable by status +
// user_id, ordered REQUESTED-first then oldest-first, paginated at 50. Mirrors the
// 3.1 submissions-queue conventions. A user_id filter (parallel to 3.1's brick_id)
// keeps these tests deterministic on the shared dev DB.

const request = require('supertest');
const { app, createFreshAdmin, createFreshUser, adminReq } = require('../helpers/dex');
const { prisma, createUser, cleanup } = require('../services/bounties/helpers');

const BASE = '/api/admin/payout-requests';

let admin;
let plain;

async function seedPayout(userId, { status = 'REQUESTED', amount = 1500, method = 'PAYPAL', handle = 'u@paypal', createdAt } = {}) {
  const rows = createdAt
    ? await prisma.$queryRawUnsafe(
      `INSERT INTO payout_requests (user_id, amount_cents, payout_method, payout_handle, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz) RETURNING id`,
      BigInt(userId), amount, method, handle, status, createdAt)
    : await prisma.$queryRawUnsafe(
      `INSERT INTO payout_requests (user_id, amount_cents, payout_method, payout_handle, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      BigInt(userId), amount, method, handle, status);
  return rows[0].id;
}

function ids(res) {
  return res.body.data.payoutRequests.map((p) => p.id);
}

beforeAll(async () => {
  admin = await createFreshAdmin('u39admin');
  plain = await createFreshUser('u39plain');
});

afterAll(cleanup);

describe('GET /api/admin/payout-requests — auth (both paths)', () => {
  test('401 when unauthenticated', async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT (through requirePermission can_manage_settings)', async () => {
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${plain.token}`);
    expect(res.status).toBe(403);
  });

  test('200 via admin JWT (hasPermission path)', async () => {
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.payoutRequests)).toBe(true);
    expect(res.body.data.pageSize).toBe(50);
  });

  test('200 via X-Admin-Secret (transport path)', async () => {
    const res = await adminReq().get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/admin/payout-requests — cross-user (not caller-scoped)', () => {
  test('admin reads arbitrary users\' payout requests', async () => {
    const userA = await createUser({ tag: 'u39A' });
    const userB = await createUser({ tag: 'u39B' });
    const pa = await seedPayout(userA);
    const pb = await seedPayout(userB);

    const resA = await adminReq().get(`${BASE}?user_id=${userA}`);
    expect(resA.status).toBe(200);
    expect(ids(resA)).toContain(pa);
    expect(resA.body.data.payoutRequests.every((p) => p.userId === String(userA))).toBe(true);

    const resB = await adminReq().get(`${BASE}?user_id=${userB}`);
    expect(ids(resB)).toContain(pb);
    // Neither belongs to the admin -> proves it is not scoped to req.user.
  });

  test('item shape exposes the admin-review fields', async () => {
    const u = await createUser({ tag: 'u39shape' });
    const id = await seedPayout(u, { amount: 2000, method: 'VENMO', handle: 'me@venmo', status: 'REQUESTED' });
    const res = await adminReq().get(`${BASE}?user_id=${u}`);
    const item = res.body.data.payoutRequests.find((p) => p.id === id);
    expect(item).toMatchObject({
      id, userId: String(u), amountCents: 2000, payoutMethod: 'VENMO',
      payoutHandle: 'me@venmo', status: 'REQUESTED',
    });
    expect(item).toHaveProperty('reviewedBy');
    expect(item).toHaveProperty('reviewedAt');
    expect(item).toHaveProperty('paidAt');
    expect(item).toHaveProperty('createdAt');
  });
});

describe('GET /api/admin/payout-requests — ordering, filter, pagination', () => {
  test('REQUESTED first, then oldest-first', async () => {
    const u = await createUser({ tag: 'u39order' });
    const paidOld = await seedPayout(u, { status: 'PAID', createdAt: '2026-01-01T00:00:00Z' });
    const reqNew = await seedPayout(u, { status: 'REQUESTED', createdAt: '2026-02-01T00:00:00Z' });
    const reqOld = await seedPayout(u, { status: 'REQUESTED', createdAt: '2026-01-15T00:00:00Z' });

    const res = await adminReq().get(`${BASE}?user_id=${u}`);
    expect(res.status).toBe(200);
    // Both REQUESTED (oldest-first within the group) ahead of the older PAID.
    expect(ids(res)).toEqual([reqOld, reqNew, paidOld]);
  });

  test('status filter narrows correctly', async () => {
    const u = await createUser({ tag: 'u39filter' });
    const req1 = await seedPayout(u, { status: 'REQUESTED' });
    await seedPayout(u, { status: 'PAID' });
    await seedPayout(u, { status: 'REJECTED' });

    const res = await adminReq().get(`${BASE}?user_id=${u}&status=REQUESTED`);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([req1]);
    expect(res.body.data.payoutRequests.every((p) => p.status === 'REQUESTED')).toBe(true);
  });

  test('bad status value -> 422', async () => {
    const res = await adminReq().get(`${BASE}?status=BOGUS`);
    expect(res.status).toBe(422);
    expect(res.body.errors.status).toBeDefined();
  });

  test('paginates at 50 (page 1 = 50, page 2 = remainder)', async () => {
    const u = await createUser({ tag: 'u39page' });
    await prisma.$executeRawUnsafe(
      `INSERT INTO payout_requests (user_id, amount_cents, payout_method, payout_handle, status, created_at)
       SELECT $1, 1000, 'PAYPAL', 'p@p', 'REQUESTED',
              TIMESTAMPTZ '2026-03-01 00:00:00' + (g || ' seconds')::interval
       FROM generate_series(1, 51) g`,
      BigInt(u));

    const p1 = await adminReq().get(`${BASE}?user_id=${u}`);
    expect(p1.status).toBe(200);
    expect(p1.body.data.payoutRequests).toHaveLength(50);

    const p2 = await adminReq().get(`${BASE}?user_id=${u}&page=2`);
    expect(p2.body.data.payoutRequests).toHaveLength(1);
    const p1ids = new Set(ids(p1));
    expect(p1ids.has(ids(p2)[0])).toBe(false);
  });
});
