'use strict';

// Unit 3.2 — POST /api/admin/bounty-submissions/:id/approve (plain approve =
// reward-but-NOT-applied; bounty stays OPEN). Thin over Phase A
// BountyApprovalService.approve. Reuses the 3.1 admin pattern (createFreshAdmin +
// adminReq + requirePermission).

const request = require('supertest');
const { app, createFreshAdmin, createFreshUser, adminReq } = require('../helpers/dex');
const {
  prisma, createUser, createBrick, cleanup, instanceIdByType,
  balanceFor, xpEventsFor, setAdminSetting,
} = require('../services/bounties/helpers');
const Inst = require('../../src/services/bounties/BountyInstanceService');
const Sub = require('../../src/services/bounties/BountySubmissionService');

const DUMMY_UUID = '11111111-1111-4111-8111-999999999999';
const url = (id) => `/api/admin/bounty-submissions/${id}/approve`;

let admin;
let plain;

// Fresh submitter + brick + OPEN PACKAGING_BACK bounty + PENDING IMAGE submission
// (captured reward 75c / 75cr / 15xp). Fresh submitter => first approval.
async function makePending(tag) {
  const submitterId = await createUser({ verified: true, tag });
  const brickId = await createBrick({ tag });
  const brick = await Inst.getBrickForGeneration(prisma, brickId);
  await Inst.generateForBrick(prisma, brick);
  const instanceId = await instanceIdByType(brickId, 'PACKAGING_BACK');
  const sub = await Sub.submit(prisma, {
    userId: submitterId, bountyInstanceId: instanceId, submissionType: 'IMAGE', contentUrl: 'https://x/p.png',
  });
  return { submissionId: sub.id, submitterId, instanceId, brickId };
}

async function instanceStatus(instanceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status FROM bounty_instances WHERE id = $1::uuid`, instanceId
  );
  return rows[0] ? rows[0].status : null;
}

beforeAll(async () => {
  admin = await createFreshAdmin('u32admin');
  plain = await createFreshUser('u32plain');
  // Keep spent at the shared baseline (0) so reward tests reliably pay cash
  // against the seeded 50000 budget. Do NOT touch budget/cash_rewards_enabled:
  // reader suites (BountyDefinitionService) assert their seeded defaults, and
  // writing/snapshot-restoring them pollutes the shared admin_settings singleton
  // under parallel runs.
  await setAdminSetting('monthly_cash_spent_cents', 0);
});

afterAll(async () => {
  await setAdminSetting('monthly_cash_spent_cents', 0);
  await cleanup();
});

describe('POST /admin/bounty-submissions/:id/approve — auth', () => {
  test('401 when unauthenticated', async () => {
    const res = await request(app).post(url(DUMMY_UUID));
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT', async () => {
    const res = await request(app).post(url(DUMMY_UUID)).set('Authorization', `Bearer ${plain.token}`);
    expect(res.status).toBe(403);
  });

  test('200 via admin JWT (hasPermission path)', async () => {
    const p = await makePending('u32jwt');
    const res = await request(app).post(url(p.submissionId)).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPROVED');
  });

  test('200 via X-Admin-Secret (transport path)', async () => {
    const p = await makePending('u32secret');
    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /admin/bounty-submissions/:id/approve — behavior', () => {
  test('approves a PENDING submission: rewards paid, bounty stays OPEN, xp written', async () => {
    const p = await makePending('u32reward');
    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPROVED');

    const bal = await balanceFor(p.submitterId);
    expect(bal.cash_balance_cents).toBe(75);
    expect(bal.credit_balance).toBe(75);
    expect(bal.lifetime_cash_earned_cents).toBe(75);
    expect(bal.lifetime_credits_earned).toBe(75);

    // Plain-approve invariant: the bounty instance is NOT closed.
    expect(await instanceStatus(p.instanceId)).toBe('OPEN');

    const xps = await xpEventsFor(p.submitterId);
    expect(xps.some((x) => x.event_type === 'BOUNTY_SUBMISSION_APPROVED')).toBe(true);
  });

  test('idempotent re-approve: no double reward, still 200/APPROVED', async () => {
    const p = await makePending('u32idem');
    const r1 = await adminReq().post(url(p.submissionId));
    expect(r1.status).toBe(200);
    const bal1 = await balanceFor(p.submitterId);

    const r2 = await adminReq().post(url(p.submissionId));
    expect(r2.status).toBe(200);
    expect(r2.body.data.submission.status).toBe('APPROVED');
    const bal2 = await balanceFor(p.submitterId);
    expect(bal2.cash_balance_cents).toBe(bal1.cash_balance_cents);
    expect(bal2.credit_balance).toBe(bal1.credit_balance);
    expect(bal2.lifetime_cash_earned_cents).toBe(bal1.lifetime_cash_earned_cents);
  });

  test('409 for a non-PENDING (REJECTED) submission', async () => {
    const p = await makePending('u32rej');
    await prisma.$executeRawUnsafe(
      `UPDATE bounty_submissions SET status = 'REJECTED' WHERE id = $1::uuid`, p.submissionId
    );
    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test('404 when the submission does not exist', async () => {
    const res = await adminReq().post(url(DUMMY_UUID));
    expect(res.status).toBe(404);
  });

  // Budget-cap behavior (cash_rewards_enabled=false / budget exhaustion -> $0
  // cash, full credits + XP) is owned and proven at the service layer
  // (money-transactions.test.js, "budget cap (Q6)" + "cash_rewards_enabled=false").
  // Re-asserting it here would only duplicate that coverage AND toggle the shared
  // admin_settings.cash_rewards_enabled singleton, racing parallel money suites.
});
