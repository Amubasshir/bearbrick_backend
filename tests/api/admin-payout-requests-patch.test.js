'use strict';

// Unit 3.10 — PATCH /api/admin/payout-requests/:id (approve / mark_paid / reject;
// flag can_manage_settings). THE LAST ENDPOINT. Thin action-dispatcher over the
// Phase A PayoutService state machine — no payout logic added here. Body
// {action:"approve"|"mark_paid"|"reject", notes?}. Reserve accounting + idempotent
// mark-paid (paid_at-null guard) + advisory locks all live in the service.
//
// Real-behavior notes (confirmed from PayoutService, some ≠ the naive assumption):
//   - markPaid requires the payout be APPROVED first (Requested -> Approved -> Paid
//     enforced per Jake item 1); a mark_paid on a REQUESTED -> 409 (cannot_pay_requested).
//   - reject notes is OPTIONAL (admin_notes nullable) — not required, no 422.
//   - markPaid decrements BOTH cash and reserved by amount; reject releases reserve.

const request = require('supertest');
const { app, createFreshAdmin, createFreshUser, adminReq } = require('../helpers/dex');
const {
  prisma, createUser, cleanup, seedBalance, balanceFor,
} = require('../services/bounties/helpers');
const Payout = require('../../src/services/bounties/PayoutService');

const url = (id) => `/api/admin/payout-requests/${id}`;
const DUMMY_UUID = '11111111-1111-4111-8111-999999999999';

let admin;
let plain;

// Real REQUESTED payout with genuine reserve accounting (cash=amount, reserved=amount).
async function makeRequested(tag, amount = 1500) {
  const userId = await createUser({ tag });
  await seedBalance(userId, { cash: amount, reserved: 0 });
  const pr = await Payout.request(prisma, {
    userId, amountCents: amount, payoutMethod: 'PAYPAL', payoutHandle: 'x@paypal',
  });
  return { userId, payoutId: pr.id, amount };
}
async function makeApproved(tag, amount = 1500) {
  const r = await makeRequested(tag, amount);
  await Payout.approve(prisma, { payoutRequestId: r.payoutId });
  return r;
}
async function payoutRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, paid_at, admin_notes, reviewed_by FROM payout_requests WHERE id = $1::uuid`, id);
  return rows[0];
}

beforeAll(async () => {
  admin = await createFreshAdmin('u310admin');
  plain = await createFreshUser('u310plain');
});

afterAll(cleanup);

describe('PATCH /api/admin/payout-requests/:id — auth (both paths)', () => {
  test('401 when unauthenticated', async () => {
    const res = await request(app).patch(url(DUMMY_UUID)).send({ action: 'approve' });
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT (through requirePermission can_manage_settings)', async () => {
    const res = await request(app).patch(url(DUMMY_UUID))
      .set('Authorization', `Bearer ${plain.token}`).send({ action: 'approve' });
    expect(res.status).toBe(403);
  });

  test('200 via admin JWT (hasPermission path)', async () => {
    const r = await makeRequested('u310jwt');
    const res = await request(app).patch(url(r.payoutId))
      .set('Authorization', `Bearer ${admin.token}`).send({ action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.data.payoutRequest.status).toBe('APPROVED');
  });

  test('200 via X-Admin-Secret (null actor must not error)', async () => {
    const r = await makeRequested('u310secret');
    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect((await payoutRow(r.payoutId)).reviewed_by).toBeNull(); // secret-mode actor
  });
});

describe('PATCH /api/admin/payout-requests/:id — transitions & accounting', () => {
  test('approve: REQUESTED -> APPROVED', async () => {
    const r = await makeRequested('u310approve');
    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.data.payoutRequest.status).toBe('APPROVED');
    expect((await payoutRow(r.payoutId)).status).toBe('APPROVED');
  });

  test('mark_paid: APPROVED -> PAID, cash + reserved both decremented', async () => {
    const r = await makeApproved('u310pay', 1500);
    // Precondition: reserve is held.
    let bal = await balanceFor(r.userId);
    expect(bal.cash_balance_cents).toBe(1500);
    expect(bal.reserved_cash_cents).toBe(1500);

    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'mark_paid' });
    expect(res.status).toBe(200);
    expect(res.body.data.payoutRequest.status).toBe('PAID');
    expect(res.body.data.payoutRequest.paidAt).not.toBeNull();

    bal = await balanceFor(r.userId);
    expect(bal.cash_balance_cents).toBe(0);     // money left the account
    expect(bal.reserved_cash_cents).toBe(0);    // reserve consumed
  });

  test('mark_paid is idempotent: second call is a 200 no-op, no double decrement', async () => {
    const r = await makeApproved('u310idem', 1500);
    const r1 = await adminReq().patch(url(r.payoutId)).send({ action: 'mark_paid' });
    expect(r1.status).toBe(200);
    const balAfter = await balanceFor(r.userId);

    const r2 = await adminReq().patch(url(r.payoutId)).send({ action: 'mark_paid' });
    expect(r2.status).toBe(200);
    expect(r2.body.data.payoutRequest.status).toBe('PAID');
    const balNow = await balanceFor(r.userId);
    expect(balNow.cash_balance_cents).toBe(balAfter.cash_balance_cents);
    expect(balNow.reserved_cash_cents).toBe(balAfter.reserved_cash_cents);
  });

  test('approve is idempotent: double approve is a 200 (not 409)', async () => {
    const r = await makeRequested('u310apidem');
    await adminReq().patch(url(r.payoutId)).send({ action: 'approve' });
    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.data.payoutRequest.status).toBe('APPROVED');
  });

  test('reject: -> REJECTED, reserve released (cash unchanged), notes persisted', async () => {
    const r = await makeRequested('u310reject', 1500);
    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'reject', notes: 'bad handle' });
    expect(res.status).toBe(200);
    expect(res.body.data.payoutRequest.status).toBe('REJECTED');

    const bal = await balanceFor(r.userId);
    expect(bal.reserved_cash_cents).toBe(0);      // reserve released
    expect(bal.cash_balance_cents).toBe(1500);    // cash unchanged -> available back to 1500
    expect((await payoutRow(r.payoutId)).admin_notes).toBe('bad handle');
  });

  test('mark_paid on a REQUESTED (not yet approved) -> 409 (must be APPROVED first)', async () => {
    const r = await makeRequested('u310reqpaid', 1500);
    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'mark_paid' });
    expect(res.status).toBe(409); // Requested -> Approved -> Paid enforced (Jake item 1)
    expect((await payoutRow(r.payoutId)).status).toBe('REQUESTED'); // unchanged, not paid
  });
});

describe('PATCH /api/admin/payout-requests/:id — illegal states & validation', () => {
  test('reject a PAID -> 409', async () => {
    const r = await makeApproved('u310rejpaid');
    await adminReq().patch(url(r.payoutId)).send({ action: 'mark_paid' });
    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'reject' });
    expect(res.status).toBe(409);
  });

  test('mark_paid a REJECTED -> 409', async () => {
    const r = await makeRequested('u310payrej');
    await adminReq().patch(url(r.payoutId)).send({ action: 'reject' });
    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'mark_paid' });
    expect(res.status).toBe(409);
  });

  test('approve a PAID -> 409', async () => {
    const r = await makeApproved('u310apppaid');
    await adminReq().patch(url(r.payoutId)).send({ action: 'mark_paid' });
    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'approve' });
    expect(res.status).toBe(409);
  });

  test('not found -> 404', async () => {
    const res = await adminReq().patch(url(DUMMY_UUID)).send({ action: 'approve' });
    expect(res.status).toBe(404);
  });

  test('bad action -> 422', async () => {
    const r = await makeRequested('u310badaction');
    const res = await adminReq().patch(url(r.payoutId)).send({ action: 'frobnicate' });
    expect(res.status).toBe(422);
    expect(res.body.errors.action).toBeDefined();
  });

  test('missing action -> 422', async () => {
    const r = await makeRequested('u310noaction');
    const res = await adminReq().patch(url(r.payoutId)).send({});
    expect(res.status).toBe(422);
    expect(res.body.errors.action).toBeDefined();
  });
});
