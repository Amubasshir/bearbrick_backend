'use strict';

// Unit 1.3 — GET /api/me/bounty-submissions (auth-required; caller's own
// submission history, newest-first). Seeds submissions directly (explicit
// created_at + a REJECTED row) referencing a tracked brick so cleanup removes
// them by brick_id. User rows are not deleted (broad FKs) — unique emails/run.

const request = require('supertest');
const app = require('../../src/app');
const { prisma, createBrick, cleanup, instanceIdByType } = require('../services/bounties/helpers');
const { createFreshUser } = require('../helpers/dex');
const Inst = require('../../src/services/bounties/BountyInstanceService');

const T1 = '2026-06-10T00:00:00.000Z'; // older
const T2 = '2026-06-11T00:00:00.000Z'; // newer

const EXPECTED_KEYS = [
  'adminNotes', 'bountyInstanceId', 'brickId', 'contentText', 'contentUrl',
  'createdAt', 'id', 'notes', 'rejectionReasons', 'reviewedAt',
  'rewardCashCents', 'rewardCredits', 'rewardXp', 'sourceUrl', 'status', 'submissionType',
].sort();

async function insertSubmission(userId, brickId, instanceId, opts = {}) {
  const {
    status = 'PENDING', submissionType = 'IMAGE',
    contentUrl = null, contentText = null, sourceUrl = null, notes = null,
    rejectionReasons = null, adminNotes = null,
    cash = 0, credit = 0, xp = 0, createdAt, reviewedAt = null,
  } = opts;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bounty_submissions
       (bounty_instance_id, brick_id, user_id, submission_type,
        content_url, content_text, source_url, notes,
        status, rejection_reasons, admin_notes, reviewed_at,
        cash_reward_cents, credit_reward, xp_reward, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz,
             $13, $14, $15, $16::timestamptz, $16::timestamptz)
     RETURNING id`,
    instanceId, brickId, BigInt(userId), submissionType,
    contentUrl, contentText, sourceUrl, notes,
    status, rejectionReasons, adminNotes, reviewedAt,
    cash, credit, xp, createdAt
  );
  return rows[0].id;
}

let userA;      // { token, userId }
let userB;
let userEmpty;
let brickId;
let instFront;
let instBack;
let instSide;
let aPending;   // A: PENDING @ T1
let aRejected;  // A: REJECTED @ T2 (newer)
let bPending;   // B: PENDING @ T1

beforeAll(async () => {
  userA = await createFreshUser('u13a');
  userB = await createFreshUser('u13b');
  userEmpty = await createFreshUser('u13empty');

  brickId = await createBrick({ tag: 'u13' });
  const brick = await Inst.getBrickForGeneration(prisma, brickId);
  await Inst.generateForBrick(prisma, brick);
  instFront = await instanceIdByType(brickId, 'PACKAGING_FRONT');
  instBack = await instanceIdByType(brickId, 'PACKAGING_BACK');
  instSide = await instanceIdByType(brickId, 'SIDE_VIEW');

  aPending = await insertSubmission(userA.userId, brickId, instFront, {
    status: 'PENDING', submissionType: 'IMAGE', contentUrl: 'https://x/front.png',
    cash: 50, credit: 50, xp: 15, createdAt: T1,
  });
  aRejected = await insertSubmission(userA.userId, brickId, instBack, {
    status: 'REJECTED', submissionType: 'IMAGE', contentUrl: 'https://x/back.png',
    rejectionReasons: ['Blurry image'], adminNotes: 'Please retake in better light',
    cash: 0, credit: 0, xp: 0, createdAt: T2, reviewedAt: T2,
  });
  bPending = await insertSubmission(userB.userId, brickId, instSide, {
    status: 'PENDING', submissionType: 'DATA', contentText: 'lottery',
    cash: 25, credit: 25, xp: 10, createdAt: T1,
  });
});

afterAll(cleanup);

function ids(body) {
  return body.data.submissions.map((s) => s.id);
}

describe('GET /api/me/bounty-submissions', () => {
  test('401 when unauthenticated (no Bearer header)', async () => {
    const res = await request(app).get('/api/me/bounty-submissions');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/unauthenticated/i);
  });

  test("returns the caller's own submissions, newest-first", async () => {
    const res = await request(app)
      .get('/api/me/bounty-submissions')
      .set('Authorization', `Bearer ${userA.token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // A has exactly 2, newest (aRejected @ T2) first.
    expect(ids(res.body)).toEqual([aRejected, aPending]);
  });

  test("isolation: caller A never sees caller B's rows (and vice versa)", async () => {
    const resA = await request(app)
      .get('/api/me/bounty-submissions')
      .set('Authorization', `Bearer ${userA.token}`);
    expect(ids(resA.body)).toEqual([aRejected, aPending]);
    expect(ids(resA.body)).not.toContain(bPending);

    const resB = await request(app)
      .get('/api/me/bounty-submissions')
      .set('Authorization', `Bearer ${userB.token}`);
    expect(ids(resB.body)).toEqual([bPending]);
    expect(ids(resB.body)).not.toContain(aPending);
    expect(ids(resB.body)).not.toContain(aRejected);
  });

  test('item shape is camelCase with exactly the intended fields; rewards are the captured values', async () => {
    const res = await request(app)
      .get('/api/me/bounty-submissions')
      .set('Authorization', `Bearer ${userA.token}`);
    const pending = res.body.data.submissions.find((s) => s.id === aPending);
    expect(Object.keys(pending).sort()).toEqual(EXPECTED_KEYS);
    expect(pending).toMatchObject({
      id: aPending,
      bountyInstanceId: instFront,
      brickId,
      submissionType: 'IMAGE',
      status: 'PENDING',
      rewardCashCents: 50,   // captured on the row, not re-read from the definition
      rewardCredits: 50,
      rewardXp: 15,
      contentUrl: 'https://x/front.png',
      contentText: null,
      rejectionReasons: null,
      adminNotes: null,
      reviewedAt: null,
    });
    expect(typeof pending.createdAt).toBe('string');
  });

  test('a rejected submission surfaces rejectionReasons and adminNotes', async () => {
    const res = await request(app)
      .get('/api/me/bounty-submissions')
      .set('Authorization', `Bearer ${userA.token}`);
    const rejected = res.body.data.submissions.find((s) => s.id === aRejected);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReasons).toEqual(['Blurry image']);
    expect(rejected.adminNotes).toBe('Please retake in better light');
    expect(typeof rejected.reviewedAt).toBe('string');
  });

  test('empty history returns {success:true,data:{submissions:[]}}', async () => {
    const res = await request(app)
      .get('/api/me/bounty-submissions')
      .set('Authorization', `Bearer ${userEmpty.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { submissions: [] } });
  });
});
