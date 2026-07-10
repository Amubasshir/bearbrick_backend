'use strict';

// Unit B2 — duplicate-field advisory across the admin surfaces. The review queue
// (3.1) is the PRE-DECISION surface: each PENDING item flags whether its
// brick+field already has an APPROVED-but-unapplied sibling. The approve (3.2) and
// approve-without-applying (3.4) responses ECHO the same advisory after the fact.
// The warning is advisory ONLY — approval always succeeds, never blocked.

const request = require('supertest');
const { app, createFreshAdmin, adminReq } = require('../helpers/dex');
const {
  prisma, createUser, createBrick, cleanup, instanceIdByType, balanceFor, setAdminSetting,
} = require('../services/bounties/helpers');
const Inst = require('../../src/services/bounties/BountyInstanceService');
const Sub = require('../../src/services/bounties/BountySubmissionService');

const QUEUE = '/api/admin/bounty-submissions';
const approveUrl = (id) => `/api/admin/bounty-submissions/${id}/approve`;
const approveWithoutUrl = (id) => `/api/admin/bounty-submissions/${id}/approve-without-applying`;

let admin;

async function freshBrick(tag) {
  const brickId = await createBrick({ tag });
  const brick = await Inst.getBrickForGeneration(prisma, brickId);
  await Inst.generateForBrick(prisma, brick);
  return {
    brickId,
    instBack: await instanceIdByType(brickId, 'PACKAGING_BACK'),
    instYear: await instanceIdByType(brickId, 'RELEASE_YEAR'),
  };
}

// Real PENDING submission (captures rewards) via the service.
async function makePending(brickId, instanceId, tag) {
  const submitterId = await createUser({ verified: true, tag });
  const sub = await Sub.submit(prisma, {
    userId: submitterId, bountyInstanceId: instanceId, submissionType: 'IMAGE', contentUrl: 'https://x/p.png',
  });
  return { submissionId: sub.id, submitterId };
}

// Seed an APPROVED-but-unapplied sibling directly (only status/brick/field matter).
async function seedApproved(brickId, instanceId) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bounty_submissions
       (bounty_instance_id, brick_id, user_id, submission_type, content_url,
        status, created_at, updated_at, cash_reward_cents, credit_reward, xp_reward)
     VALUES ($1::uuid, $2, $3, 'IMAGE', 'https://x/p.png', 'APPROVED', NOW(), NOW(), 0, 0, 0)
     RETURNING id`,
    instanceId, brickId, BigInt(await createUser({ verified: true, tag: 'b2sib' }))
  );
  return rows[0].id;
}

function itemById(res, id) {
  return res.body.data.submissions.find((s) => s.id === id);
}
async function instanceStatus(instanceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status FROM bounty_instances WHERE id = $1::uuid`, instanceId);
  return rows[0] ? rows[0].status : null;
}

beforeAll(async () => {
  admin = await createFreshAdmin('b2admin');
  await setAdminSetting('monthly_cash_spent_cents', 0);
});

afterAll(async () => {
  await setAdminSetting('monthly_cash_spent_cents', 0);
  await cleanup();
});

describe('review queue — duplicate-field advisory (primary, pre-decision surface)', () => {
  test('PENDING item with an APPROVED-unapplied sibling shows duplicateFieldWarning + descriptor', async () => {
    const b = await freshBrick('b2q-warn');
    const sib = await seedApproved(b.brickId, b.instBack);
    const p = await makePending(b.brickId, b.instBack, 'b2q-warn-p');

    const res = await adminReq().get(`${QUEUE}?brick_id=${b.brickId}`);
    expect(res.status).toBe(200);
    const item = itemById(res, p.submissionId);
    expect(item.duplicateFieldWarning).toBe(true);
    expect(item.duplicateFieldSiblings).toEqual({ count: 1, submissionIds: [sib] });
  });

  test('PENDING item with no sibling: duplicateFieldWarning false, no descriptor', async () => {
    const b = await freshBrick('b2q-clean');
    const p = await makePending(b.brickId, b.instBack, 'b2q-clean-p');

    const res = await adminReq().get(`${QUEUE}?brick_id=${b.brickId}`);
    expect(res.status).toBe(200);
    const item = itemById(res, p.submissionId);
    expect(item.duplicateFieldWarning).toBe(false);
    expect(item.duplicateFieldSiblings).toBeNull();
  });

  test('a sibling on a DIFFERENT field does not trip the warning', async () => {
    const b = await freshBrick('b2q-field');
    await seedApproved(b.brickId, b.instBack); // APPROVED on packaging_back
    const pYear = await makePending(b.brickId, b.instYear, 'b2q-field-year'); // PENDING on release_year

    const res = await adminReq().get(`${QUEUE}?brick_id=${b.brickId}`);
    const item = itemById(res, pYear.submissionId);
    expect(item.duplicateFieldWarning).toBe(false);
    expect(item.duplicateFieldSiblings).toBeNull();
  });

  test('a sibling on a DIFFERENT brick does not trip the warning', async () => {
    const a = await freshBrick('b2q-brickA');
    await seedApproved(a.brickId, a.instBack);
    const b = await freshBrick('b2q-brickB');
    const p = await makePending(b.brickId, b.instBack, 'b2q-brickB-p');

    const res = await adminReq().get(`${QUEUE}?brick_id=${b.brickId}`);
    const item = itemById(res, p.submissionId);
    expect(item.duplicateFieldWarning).toBe(false);
    expect(item.duplicateFieldSiblings).toBeNull();
  });
});

describe('approve (3.2) echo — advisory only, never blocks', () => {
  test('with a sibling: approval SUCCEEDS + reward paid + response echoes the warning', async () => {
    const b = await freshBrick('b2a-warn');
    const sib = await seedApproved(b.brickId, b.instBack);
    const p = await makePending(b.brickId, b.instBack, 'b2a-warn-p');

    const res = await adminReq().post(approveUrl(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPROVED');
    // The warning did NOT block the reward.
    const bal = await balanceFor(p.submitterId);
    expect(bal.cash_balance_cents).toBe(75);
    // Echo (self excluded -> only the pre-existing sibling).
    expect(res.body.data.duplicateFieldWarning).toBe(true);
    expect(res.body.data.duplicateFieldSiblings).toEqual({ count: 1, submissionIds: [sib] });
  });

  test('without a sibling: approval SUCCEEDS and no warning is echoed', async () => {
    const b = await freshBrick('b2a-clean');
    const p = await makePending(b.brickId, b.instBack, 'b2a-clean-p');

    const res = await adminReq().post(approveUrl(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPROVED');
    expect(res.body.data.duplicateFieldWarning).toBe(false);
    expect(res.body.data.duplicateFieldSiblings).toBeNull();
  });
});

describe('approve-without-applying (3.4) echo — advisory only, never blocks', () => {
  test('with a sibling: SUCCEEDS + reward paid + instance stays OPEN + warning echoed', async () => {
    const b = await freshBrick('b2w-warn');
    const sib = await seedApproved(b.brickId, b.instBack);
    const p = await makePending(b.brickId, b.instBack, 'b2w-warn-p');

    const res = await adminReq().post(approveWithoutUrl(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPROVED');
    const bal = await balanceFor(p.submitterId);
    expect(bal.cash_balance_cents).toBe(75);
    expect(await instanceStatus(b.instBack)).toBe('OPEN');
    expect(res.body.data.duplicateFieldWarning).toBe(true);
    expect(res.body.data.duplicateFieldSiblings).toEqual({ count: 1, submissionIds: [sib] });
  });

  test('without a sibling: SUCCEEDS and no warning is echoed', async () => {
    const b = await freshBrick('b2w-clean');
    const p = await makePending(b.brickId, b.instBack, 'b2w-clean-p');

    const res = await adminReq().post(approveWithoutUrl(p.submissionId));
    expect(res.status).toBe(200);
    expect(res.body.data.submission.status).toBe('APPROVED');
    expect(res.body.data.duplicateFieldWarning).toBe(false);
    expect(res.body.data.duplicateFieldSiblings).toBeNull();
  });
});
