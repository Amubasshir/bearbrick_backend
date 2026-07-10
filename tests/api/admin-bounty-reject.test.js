'use strict';

// Unit 3.5 — POST /api/admin/bounty-submissions/:id/reject. Sets a PENDING
// submission to REJECTED with reasons + admin notes, updates stats (rejected+1,
// pending-1, recompute approval_rate). NO reward, NO XP, instance stays OPEN.
// Flag can_approve_images. Thin new BountySubmissionService.reject.

const request = require('supertest');
const { app, createFreshAdmin, createFreshUser, adminReq } = require('../helpers/dex');
const {
  prisma, createUser, createBrick, cleanup, instanceIdByType,
  balanceFor, xpEventsFor, rewardEventsFor, statsFor, setAdminSetting,
} = require('../services/bounties/helpers');
const Inst = require('../../src/services/bounties/BountyInstanceService');
const Sub = require('../../src/services/bounties/BountySubmissionService');

const DUMMY_UUID = '11111111-1111-4111-8111-999999999999';
const url = (id) => `/api/admin/bounty-submissions/${id}/reject`;
const REASONS = ['Blurry image', 'Wrong angle'];
const NOTES = 'Please retake in better light.';

let admin;
let plain;

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
    `SELECT status FROM bounty_instances WHERE id = $1::uuid`, instanceId);
  return rows[0] ? rows[0].status : null;
}

beforeAll(async () => {
  admin = await createFreshAdmin('u35admin');
  plain = await createFreshUser('u35plain');
  await setAdminSetting('monthly_cash_spent_cents', 0);
});

afterAll(async () => {
  await setAdminSetting('monthly_cash_spent_cents', 0);
  await cleanup();
});

describe('POST /admin/bounty-submissions/:id/reject — auth', () => {
  test('401 when unauthenticated', async () => {
    const res = await request(app).post(url(DUMMY_UUID)).send({ rejectionReasons: REASONS });
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT', async () => {
    const res = await request(app).post(url(DUMMY_UUID))
      .set('Authorization', `Bearer ${plain.token}`).send({ rejectionReasons: REASONS });
    expect(res.status).toBe(403);
  });

  test('200 via admin JWT (hasPermission path)', async () => {
    const p = await makePending('u35jwt');
    const res = await request(app).post(url(p.submissionId))
      .set('Authorization', `Bearer ${admin.token}`).send({ rejectionReasons: REASONS });
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('REJECTED');
  });

  test('200 via X-Admin-Secret (reviewed_by null under secret-mode must not error)', async () => {
    const p = await makePending('u35secret');
    const res = await adminReq().post(url(p.submissionId)).send({ rejectionReasons: REASONS });
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('REJECTED');
  });
});

describe('POST /admin/bounty-submissions/:id/reject — behavior', () => {
  test('rejects PENDING: reasons + notes persisted, stats updated, NO reward/XP, instance stays OPEN', async () => {
    const p = await makePending('u35reject');
    const res = await adminReq().post(url(p.submissionId)).send({ rejectionReasons: REASONS, adminNotes: NOTES });
    expect(res.status).toBe(200);

    const s = res.body.data.submission;
    expect(s.status).toBe('REJECTED');
    expect(s.rejectionReasons).toEqual(REASONS);
    expect(s.adminNotes).toBe(NOTES);
    expect(typeof s.reviewedAt).toBe('string');

    // Stats: rejected+1, pending-1, approval_rate recomputed (0 accepted / 1 => 0).
    const st = await statsFor(p.submitterId);
    expect(st.rejected_submissions).toBe(1);
    expect(st.pending_submissions).toBe(0);
    expect(Number(st.approval_rate)).toBe(0);

    // No money, no XP.
    expect(await balanceFor(p.submitterId)).toBeNull();
    expect(await rewardEventsFor(p.submitterId)).toHaveLength(0);
    expect(await xpEventsFor(p.submitterId)).toHaveLength(0);

    // Rejection does NOT close the bounty — someone else can still submit.
    expect(await instanceStatus(p.instanceId)).toBe('OPEN');
  });

  test('422 when rejectionReasons is missing or empty', async () => {
    const p = await makePending('u35noreasons');
    const r1 = await adminReq().post(url(p.submissionId)).send({});
    expect(r1.status).toBe(422);
    expect(r1.body.errors).toHaveProperty('rejectionReasons');

    const r2 = await adminReq().post(url(p.submissionId)).send({ rejectionReasons: [] });
    expect(r2.status).toBe(422);
    expect(r2.body.errors).toHaveProperty('rejectionReasons');
  });

  test('409 for a non-PENDING submission (already rejected)', async () => {
    const p = await makePending('u35already');
    const first = await adminReq().post(url(p.submissionId)).send({ rejectionReasons: REASONS });
    expect(first.status).toBe(200);
    const again = await adminReq().post(url(p.submissionId)).send({ rejectionReasons: REASONS });
    expect(again.status).toBe(409);
  });

  test('404 when the submission does not exist', async () => {
    const res = await adminReq().post(url(DUMMY_UUID)).send({ rejectionReasons: REASONS });
    expect(res.status).toBe(404);
  });
});
