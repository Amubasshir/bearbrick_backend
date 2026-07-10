'use strict';

// Unit 1.4 — GET /api/me/balances (auth-required; caller's own balance).
// availableCashCents = cash - reserved via moneyMath. Seeds via seedBalance and
// sets the lifetime columns directly. Cleans up the user_balances rows it seeds
// (User rows are left per convention).

const request = require('supertest');
const app = require('../../src/app');
const { prisma, seedBalance } = require('../services/bounties/helpers');
const { createFreshUser } = require('../helpers/dex');

const EXPECTED_KEYS = [
  'cashBalanceCents', 'reservedCashCents', 'availableCashCents',
  'creditBalance', 'lifetimeCashEarnedCents', 'lifetimeCreditsEarned',
].sort();

const seededUserIds = [];

async function setLifetime(userId, { cash = 0, credits = 0 } = {}) {
  await prisma.$executeRawUnsafe(
    `UPDATE user_balances
        SET lifetime_cash_earned_cents = $2, lifetime_credits_earned = $3, updated_at = NOW()
      WHERE user_id = $1`,
    BigInt(userId), cash, credits
  );
}

let userA;      // cash 1000, reserved 300 -> available 700
let userB;      // distinct balance, proves isolation
let userMissing; // balance row deleted -> defensive zeroed response

beforeAll(async () => {
  userA = await createFreshUser('u14a');
  userB = await createFreshUser('u14b');
  userMissing = await createFreshUser('u14miss');
  seededUserIds.push(userA.userId, userB.userId, userMissing.userId);

  await seedBalance(userA.userId, { cash: 1000, reserved: 300, credits: 500 });
  await setLifetime(userA.userId, { cash: 2500, credits: 800 });

  await seedBalance(userB.userId, { cash: 50, reserved: 0, credits: 10 });
  await setLifetime(userB.userId, { cash: 50, credits: 10 });

  // Simulate a user with no balance row (leaf table, nothing FKs to it).
  await prisma.$executeRawUnsafe(
    `DELETE FROM user_balances WHERE user_id = $1`, BigInt(userMissing.userId)
  );
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(
    `DELETE FROM user_balances WHERE user_id = ANY($1::bigint[])`,
    seededUserIds.map((id) => BigInt(id))
  );
  await prisma.$disconnect();
});

describe('GET /api/me/balances', () => {
  test('401 when unauthenticated (no Bearer header)', async () => {
    const res = await request(app).get('/api/me/balances');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/unauthenticated/i);
  });

  test("returns the caller's own balance in the exact 6-field shape", async () => {
    const res = await request(app)
      .get('/api/me/balances')
      .set('Authorization', `Bearer ${userA.token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body.data).sort()).toEqual(EXPECTED_KEYS);
    expect(res.body.data).toEqual({
      cashBalanceCents: 1000,
      reservedCashCents: 300,
      availableCashCents: 700,
      creditBalance: 500,
      lifetimeCashEarnedCents: 2500,
      lifetimeCreditsEarned: 800,
    });
  });

  test('availableCashCents = cash - reserved (proven with non-zero reserved)', async () => {
    const res = await request(app)
      .get('/api/me/balances')
      .set('Authorization', `Bearer ${userA.token}`);
    const { cashBalanceCents, reservedCashCents, availableCashCents } = res.body.data;
    expect(reservedCashCents).toBeGreaterThan(0);
    expect(availableCashCents).toBe(cashBalanceCents - reservedCashCents);
  });

  test('isolation: caller B sees only their own balance', async () => {
    const res = await request(app)
      .get('/api/me/balances')
      .set('Authorization', `Bearer ${userB.token}`);
    expect(res.body.data).toEqual({
      cashBalanceCents: 50,
      reservedCashCents: 0,
      availableCashCents: 50,
      creditBalance: 10,
      lifetimeCashEarnedCents: 50,
      lifetimeCreditsEarned: 10,
    });
  });

  test('all six values are integers (cents/counts, never floats)', async () => {
    const res = await request(app)
      .get('/api/me/balances')
      .set('Authorization', `Bearer ${userA.token}`);
    for (const v of Object.values(res.body.data)) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  test('missing balance row returns a defensive zeroed balance (200, not 404)', async () => {
    const res = await request(app)
      .get('/api/me/balances')
      .set('Authorization', `Bearer ${userMissing.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      cashBalanceCents: 0,
      reservedCashCents: 0,
      availableCashCents: 0,
      creditBalance: 0,
      lifetimeCashEarnedCents: 0,
      lifetimeCreditsEarned: 0,
    });
  });
});
