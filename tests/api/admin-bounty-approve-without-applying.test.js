'use strict';

// Unit 3.4 — POST /api/admin/bounty-submissions/:id/approve-without-applying.
// Explicit plain-approve endpoint ("reward now, verify, apply later"): same
// reward semantics as 3.2, distinctly named. Defining invariants: instance stays
// OPEN and the canonical brick field is NOT written. Thin over the same
// BountyApprovalService.approve.

const request = require('supertest');
const { app, createFreshAdmin, createFreshUser, adminReq } = require('../helpers/dex');
const {
  prisma, createUser, createBrick, cleanup, instanceIdByType, balanceFor, xpEventsFor,
  rewardEventsFor, setAdminSetting,
} = require('../services/bounties/helpers');
const Inst = require('../../src/services/bounties/BountyInstanceService');
const Sub = require('../../src/services/bounties/BountySubmissionService');
const Approve = require('../../src/services/bounties/BountyApprovalService');

const DUMMY_UUID = '11111111-1111-4111-8111-999999999999';
const url = (id) => `/api/admin/bounty-submissions/${id}/approve-without-applying`;
const IMG = 'https://x/pb.png';

let admin;
let plain;

// Fresh submitter + brick + OPEN PACKAGING_BACK bounty + PENDING IMAGE submission
// (captured 75c / 75cr / 15xp). PACKAGING_BACK targets packaging_back_image_url,
// which starts null on a fully-missing brick.
async function makePending(tag) {
  const submitterId = await createUser({ verified: true, tag });
  const brickId = await createBrick({ tag });
  const brick = await Inst.getBrickForGeneration(prisma, brickId);
  await Inst.generateForBrick(prisma, brick);
  const instanceId = await instanceIdByType(brickId, 'PACKAGING_BACK');
  const sub = await Sub.submit(prisma, {
    userId: submitterId, bountyInstanceId: instanceId, submissionType: 'IMAGE', contentUrl: IMG,
  });
  return { submissionId: sub.id, submitterId, instanceId, brickId };
}

async function instanceStatus(instanceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status FROM bounty_instances WHERE id = $1::uuid`, instanceId);
  return rows[0] ? rows[0].status : null;
}
async function brickField(brickId, col) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "${col}" AS v FROM bricks WHERE id = $1`, brickId);
  return rows[0] ? rows[0].v : null;
}

beforeAll(async () => {
  admin = await createFreshAdmin('u34admin');
  plain = await createFreshUser('u34plain');
  await setAdminSetting('monthly_cash_spent_cents', 0);
});

afterAll(async () => {
  await setAdminSetting('monthly_cash_spent_cents', 0);
  await cleanup();
});

describe('POST /admin/bounty-submissions/:id/approve-without-applying — auth', () => {
  test('401 when unauthenticated', async () => {
    const res = await request(app).post(url(DUMMY_UUID));
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT', async () => {
    const res = await request(app).post(url(DUMMY_UUID)).set('Authorization', `Bearer ${plain.token}`);
    expect(res.status).toBe(403);
  });

  test('200 via admin JWT (hasPermission path)', async () => {
    const p = await makePending('u34jwt');
    const res = await request(app).post(url(p.submissionId)).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPROVED');
  });

  test('200 via X-Admin-Secret (transport path)', async () => {
    const p = await makePending('u34secret');
    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /admin/bounty-submissions/:id/approve-without-applying — behavior', () => {
  test('rewards + APPROVED, but bounty stays OPEN and canonical field is NOT written', async () => {
    const p = await makePending('u34invariant');
    // Precondition: field starts null.
    expect(await brickField(p.brickId, 'packaging_back_image_url')).toBeNull();

    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPROVED');

    // Reward paid.
    const bal = await balanceFor(p.submitterId);
    expect(bal.cash_balance_cents).toBe(75);
    expect(bal.credit_balance).toBe(75);

    // Defining invariants: instance still OPEN, brick field still null.
    expect(await instanceStatus(p.instanceId)).toBe('OPEN');
    expect(await brickField(p.brickId, 'packaging_back_image_url')).toBeNull();

    const xps = (await xpEventsFor(p.submitterId)).map((x) => x.event_type);
    expect(xps).toContain('BOUNTY_SUBMISSION_APPROVED');
  });

  test('idempotent re-call: no double reward, still 200/APPROVED', async () => {
    const p = await makePending('u34idem');
    const r1 = await adminReq().post(url(p.submissionId));
    expect(r1.status).toBe(200);
    const bal1 = await balanceFor(p.submitterId);

    const r2 = await adminReq().post(url(p.submissionId));
    expect(r2.status).toBe(200);
    expect(r2.body.data.submission.status).toBe('APPROVED');
    const bal2 = await balanceFor(p.submitterId);
    expect(bal2.cash_balance_cents).toBe(bal1.cash_balance_cents);
    expect(bal2.credit_balance).toBe(bal1.credit_balance);
    expect(await rewardEventsFor(p.submitterId)).toHaveLength(1);
  });

  test('409 for a non-PENDING (REJECTED) submission', async () => {
    const p = await makePending('u34rej');
    await prisma.$executeRawUnsafe(
      `UPDATE bounty_submissions SET status = 'REJECTED' WHERE id = $1::uuid`, p.submissionId);
    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(409);
  });

  test('already-APPROVED is an idempotent 200 (no second reward)', async () => {
    const p = await makePending('u34already');
    await Approve.approve(prisma, { submissionId: p.submissionId });
    const balAfter = await balanceFor(p.submitterId);

    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPROVED');
    const balNow = await balanceFor(p.submitterId);
    expect(balNow.cash_balance_cents).toBe(balAfter.cash_balance_cents);
    expect(await rewardEventsFor(p.submitterId)).toHaveLength(1);
  });

  test('404 when the submission does not exist', async () => {
    const res = await adminReq().post(url(DUMMY_UUID));
    expect(res.status).toBe(404);
  });
});
