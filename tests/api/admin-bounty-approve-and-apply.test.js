'use strict';

// Unit 3.3 — POST /api/admin/bounty-submissions/:id/approve-and-apply. The heavy
// unit: PENDING -> reward+apply+close (+BRICK_COMPLETED if last); already-APPROVED
// -> apply-only (canonical write+close, NO 2nd reward); already-APPLIED -> no-op.
// Flag can_edit_bricks. Reuses the 3.1 admin pattern.

const request = require('supertest');
const { app, createFreshAdmin, createFreshUser, adminReq } = require('../helpers/dex');
const {
  prisma, createUser, createBrick, cleanup, instanceIdByType,
  balanceFor, xpEventsFor, rewardEventsFor, setAdminSetting,
} = require('../services/bounties/helpers');
const Inst = require('../../src/services/bounties/BountyInstanceService');
const Sub = require('../../src/services/bounties/BountySubmissionService');
const Approve = require('../../src/services/bounties/BountyApprovalService');

const DUMMY_UUID = '11111111-1111-4111-8111-999999999999';
const url = (id) => `/api/admin/bounty-submissions/${id}/approve-and-apply`;
const IMG = 'https://x/pb.png';

let admin;
let plain;

// Multi-bounty brick (all 8 fields null): a PENDING IMAGE submission on
// PACKAGING_BACK. Applying it closes ONE of 8 -> no BRICK_COMPLETED.
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

// Single-bounty brick (only packaging_back null): applying closes the LAST open
// bounty -> BRICK_COMPLETED fires.
async function makeSingleBountyPending(tag) {
  const submitterId = await createUser({ verified: true, tag });
  const brickId = await createBrick({
    tag,
    fields: {
      packaging_front_image_url: 'a', back_image_url: 'c', side_image_url: 'd',
      bottom_stamp_image_url: 'e', release_year: 2020, release_method: 'lottery', notes: 'n',
    },
  });
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
  admin = await createFreshAdmin('u33admin');
  plain = await createFreshUser('u33plain');
  // Keep spent at the shared baseline (0). Do NOT touch budget/cash_rewards_enabled
  // (reader suites assert their seeded defaults; writing them pollutes the shared
  // admin_settings singleton under parallel runs).
  await setAdminSetting('monthly_cash_spent_cents', 0);
});

afterAll(async () => {
  await setAdminSetting('monthly_cash_spent_cents', 0);
  await cleanup();
});

describe('POST /admin/bounty-submissions/:id/approve-and-apply — auth', () => {
  test('401 when unauthenticated', async () => {
    const res = await request(app).post(url(DUMMY_UUID));
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT (requirePermission can_edit_bricks)', async () => {
    const res = await request(app).post(url(DUMMY_UUID)).set('Authorization', `Bearer ${plain.token}`);
    expect(res.status).toBe(403);
  });

  test('200 via admin JWT (hasPermission path)', async () => {
    const p = await makePending('u33jwt');
    const res = await request(app).post(url(p.submissionId)).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPLIED_TO_BRICK');
  });

  test('200 via X-Admin-Secret (transport path)', async () => {
    const p = await makePending('u33secret');
    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(200);
  });
});

describe('POST /admin/bounty-submissions/:id/approve-and-apply — behavior', () => {
  test('PENDING: reward paid, canonical field written, instance CLOSED, BRICK_COMPLETED on last bounty', async () => {
    const p = await makeSingleBountyPending('u33pending');
    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPLIED_TO_BRICK');

    // Reward paid.
    const bal = await balanceFor(p.submitterId);
    expect(bal.cash_balance_cents).toBe(75);
    expect(bal.credit_balance).toBe(75);
    // Canonical field written to the brick (SQL, not just the response).
    expect(await brickField(p.brickId, 'packaging_back_image_url')).toBe(IMG);
    // Instance closed; last bounty -> BRICK_COMPLETED.
    expect(await instanceStatus(p.instanceId)).toBe('CLOSED');
    const xps = (await xpEventsFor(p.submitterId)).map((x) => x.event_type);
    expect(xps).toContain('BRICK_COMPLETED');
    // Exactly one reward event (the applied one).
    expect(await rewardEventsFor(p.submitterId)).toHaveLength(1);
  });

  test('already-APPROVED -> apply-only: field written + CLOSED + NO second reward', async () => {
    const p = await makePending('u33applyonly');
    // Reach APPROVED via plain approve (rewards once, instance stays OPEN).
    await Approve.approve(prisma, { submissionId: p.submissionId });
    const balAfterApprove = await balanceFor(p.submitterId);
    const rewardsAfterApprove = await rewardEventsFor(p.submitterId);
    expect(rewardsAfterApprove).toHaveLength(1);
    expect(await instanceStatus(p.instanceId)).toBe('OPEN');

    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPLIED_TO_BRICK');

    // Applied: field written + instance closed.
    expect(await brickField(p.brickId, 'packaging_back_image_url')).toBe(IMG);
    expect(await instanceStatus(p.instanceId)).toBe('CLOSED');

    // NO second reward: balances identical, still exactly one reward event.
    const balAfterApply = await balanceFor(p.submitterId);
    expect(balAfterApply.cash_balance_cents).toBe(balAfterApprove.cash_balance_cents);
    expect(balAfterApply.credit_balance).toBe(balAfterApprove.credit_balance);
    expect(balAfterApply.lifetime_cash_earned_cents).toBe(balAfterApprove.lifetime_cash_earned_cents);
    expect(await rewardEventsFor(p.submitterId)).toHaveLength(1);
  });

  test('already-APPLIED -> safe no-op (200, no second write/reward)', async () => {
    const p = await makePending('u33noop');
    const r1 = await adminReq().post(url(p.submissionId));
    expect(r1.status).toBe(200);
    const bal1 = await balanceFor(p.submitterId);
    const rewards1 = await rewardEventsFor(p.submitterId);

    const r2 = await adminReq().post(url(p.submissionId));
    expect(r2.status).toBe(200);
    expect(r2.body.data.submission.status).toBe('APPLIED_TO_BRICK');
    const bal2 = await balanceFor(p.submitterId);
    expect(bal2.cash_balance_cents).toBe(bal1.cash_balance_cents);
    expect(bal2.credit_balance).toBe(bal1.credit_balance);
    expect(await rewardEventsFor(p.submitterId)).toHaveLength(rewards1.length);
  });

  test('404 when the submission does not exist', async () => {
    const res = await adminReq().post(url(DUMMY_UUID));
    expect(res.status).toBe(404);
  });

  test('409 for a REJECTED submission (wrong state)', async () => {
    const p = await makePending('u33rej');
    await prisma.$executeRawUnsafe(
      `UPDATE bounty_submissions SET status = 'REJECTED' WHERE id = $1::uuid`, p.submissionId);
    const res = await adminReq().post(url(p.submissionId));
    expect(res.status).toBe(409);
  });
});
