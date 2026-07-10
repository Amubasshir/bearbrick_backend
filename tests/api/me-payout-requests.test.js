'use strict';

// Unit 2.3 — POST /api/me/payout-requests. Thin mapping over Phase A
// PayoutService.request (min-payout, available-balance, reserve, multiple
// pending all already enforced there). Controls minimum_payout_cents via a
// targeted setAdminSetting, reset to the seeded default in afterAll — it never
// snapshot/restores the shared global admin_settings row. Cleans up own rows.

const request = require('supertest');
const app = require('../../src/app');
const {
  prisma, seedBalance, balanceFor, setAdminSetting,
} = require('../services/bounties/helpers');
const { createFreshUser } = require('../helpers/dex');

const MIN = 1000; // minimum_payout_cents forced for this suite ($10)
const myUserIds = [];

async function fundedUser(tag, { cash = 0, reserved = 0 } = {}) {
  const u = await createFreshUser(tag);
  myUserIds.push(u.userId);
  await seedBalance(u.userId, { cash, reserved, credits: 0 });
  return u;
}

function postPayout(token, body) {
  const req = request(app).post('/api/me/payout-requests');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

beforeAll(async () => {
  // Set only the one key this suite depends on. Never snapshot/restore the shared
  // global row (a restore can re-persist another suite's transient value).
  await setAdminSetting('minimum_payout_cents', MIN);
});

afterAll(async () => {
  const uids = myUserIds.map((id) => BigInt(id));
  await prisma.$executeRawUnsafe(
    `DELETE FROM payout_action_events
      WHERE payout_request_id IN (SELECT id FROM payout_requests WHERE user_id = ANY($1::bigint[]))
         OR actor_user_id = ANY($1::bigint[])`, uids
  );
  await prisma.$executeRawUnsafe(`DELETE FROM payout_requests WHERE user_id = ANY($1::bigint[])`, uids);
  await prisma.$executeRawUnsafe(`DELETE FROM user_balances WHERE user_id = ANY($1::bigint[])`, uids);
  // Reset the one key we touched to its seeded default (never replay a snapshot).
  await setAdminSetting('minimum_payout_cents', 1000);
});

describe('POST /api/me/payout-requests', () => {
  test('401 when unauthenticated', async () => {
    const res = await postPayout(null, { amountCents: 1500, payoutMethod: 'PAYPAL', payoutHandle: 'x@pp' });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/unauthenticated/i);
  });

  test('201 for a valid request; reserves the cash and creates a REQUESTED row', async () => {
    const u = await fundedUser('u23ok', { cash: 5000, reserved: 0 });
    const res = await postPayout(u.token, { amountCents: 1500, payoutMethod: 'PAYPAL', payoutHandle: 'me@pp' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.payoutRequest).toMatchObject({
      amountCents: 1500, payoutMethod: 'PAYPAL', payoutHandle: 'me@pp', status: 'REQUESTED',
    });
    const bal = await balanceFor(u.userId);
    expect(bal.reserved_cash_cents).toBe(1500);
  });

  test('payoutHandle omitted defaults to the matching profile handle', async () => {
    const u = await fundedUser('u23def', { cash: 5000 });
    await prisma.$executeRawUnsafe(
      `UPDATE "User" SET paypal_handle = 'default@pp' WHERE id = $1`, BigInt(u.userId)
    );
    const res = await postPayout(u.token, { amountCents: 1500, payoutMethod: 'PAYPAL' });
    expect(res.status).toBe(201);
    expect(res.body.data.payoutRequest.payoutHandle).toBe('default@pp');
  });

  test('422 when payoutHandle omitted and no profile default on file', async () => {
    const u = await fundedUser('u23nohandle', { cash: 5000 });
    const res = await postPayout(u.token, { amountCents: 1500, payoutMethod: 'VENMO' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('payoutHandle');
  });

  test('422 below the minimum payout, with the minimum surfaced', async () => {
    const u = await fundedUser('u23min', { cash: 5000 });
    const res = await postPayout(u.token, { amountCents: 500, payoutMethod: 'PAYPAL', payoutHandle: 'x@pp' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('amountCents');
    expect(JSON.stringify(res.body.errors.amountCents)).toContain(String(MIN));
  });

  test('409 when available balance is insufficient (reserved makes available < amount)', async () => {
    // cash 2000 >= 1000, but reserved 1500 -> available 500 < 1000.
    const u = await fundedUser('u23insuff', { cash: 2000, reserved: 1500 });
    const res = await postPayout(u.token, { amountCents: 1000, payoutMethod: 'PAYPAL', payoutHandle: 'x@pp' });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/500|available|insufficient/i);
    // reserve unchanged (request rejected).
    const bal = await balanceFor(u.userId);
    expect(bal.reserved_cash_cents).toBe(1500);
  });

  test('422 for an invalid payoutMethod', async () => {
    const u = await fundedUser('u23badmethod', { cash: 5000 });
    const res = await postPayout(u.token, { amountCents: 1500, payoutMethod: 'BITCOIN', payoutHandle: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('payoutMethod');
  });

  test('422 when amountCents is missing / non-positive', async () => {
    const u = await fundedUser('u23noamt', { cash: 5000 });
    const res = await postPayout(u.token, { payoutMethod: 'PAYPAL', payoutHandle: 'x@pp' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('amountCents');
  });

  test('multiple pending requests allowed; reserved reflects both', async () => {
    const u = await fundedUser('u23multi', { cash: 5000, reserved: 0 });
    const r1 = await postPayout(u.token, { amountCents: 1500, payoutMethod: 'PAYPAL', payoutHandle: 'x@pp' });
    const r2 = await postPayout(u.token, { amountCents: 1200, payoutMethod: 'PAYPAL', payoutHandle: 'x@pp' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const bal = await balanceFor(u.userId);
    expect(bal.reserved_cash_cents).toBe(2700);
  });
});
