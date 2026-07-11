'use strict';

// Unit 2.2 — POST /api/bounties/:bountyInstanceId/submissions. Thin mapping over
// Phase A BountySubmissionService.submit (all gating/limit/capture/auto-reject
// logic already lives there). Verifies the SubmissionError -> HTTP status map and
// the CLOSED -> 200-with-REJECTED-row outcome. Seeds via bounties helpers.

const request = require('supertest');
const app = require('../../src/app');
const { prisma, createBrick, cleanup, instanceIdByType } = require('../services/bounties/helpers');
const { createFreshUser } = require('../helpers/dex');
const Inst = require('../../src/services/bounties/BountyInstanceService');
const { computeLocalDayKey, toDayKeyString } = require('../../src/lib/sessions');

const NONEXISTENT_UUID = '11111111-1111-4111-8111-999999999999';
const IMG_URL = 'https://signed.example/42/abc.png';

const myUserIds = [];

async function seedStatsAtLimit(userId) {
  const dayKey = toDayKeyString(computeLocalDayKey(new Date(), 'UTC'));
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_bounty_stats
       (user_id, total_submissions, pending_submissions, accepted_submissions,
        rejected_submissions, daily_submission_count, daily_submission_limit,
        daily_submission_reset_at, approval_rate, updated_at)
     VALUES ($1, 10, 0, 0, 0, 10, 10, $2::date, 0, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       daily_submission_count = 10, daily_submission_limit = 10,
       daily_submission_reset_at = $2::date, updated_at = NOW()`,
    BigInt(userId), dayKey
  );
}

function postSubmission(token, instanceId, body) {
  const req = request(app).post(`/api/bounties/${instanceId}/submissions`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

let verified;
let unverified;
let readonly;
let limited;
let brickId;
let imgInst;    // PACKAGING_BACK, OPEN, IMAGE, reward 75
let dataInst;   // RELEASE_YEAR, OPEN, DATA, reward 15
let closedInst; // SIDE_VIEW, forced CLOSED
let pausedInst; // BOTTOM_STAMP, forced PAUSED

beforeAll(async () => {
  verified = await createFreshUser('u22ok');
  unverified = await createFreshUser('u22unv');
  readonly = await createFreshUser('u22ro');
  limited = await createFreshUser('u22lim');
  myUserIds.push(verified.userId, unverified.userId, readonly.userId, limited.userId);

  await prisma.$executeRawUnsafe(
    `UPDATE "User" SET email_verified_at = NULL WHERE id = $1`, BigInt(unverified.userId)
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "User" SET account_state = 'read_only'::"AccountState" WHERE id = $1`, BigInt(readonly.userId)
  );
  await seedStatsAtLimit(limited.userId);

  brickId = await createBrick({ tag: 'u22' });
  const brick = await Inst.getBrickForGeneration(prisma, brickId);
  await Inst.generateForBrick(prisma, brick);

  imgInst = await instanceIdByType(brickId, 'PACKAGING_BACK');
  dataInst = await instanceIdByType(brickId, 'RELEASE_YEAR');
  closedInst = await instanceIdByType(brickId, 'SIDE_VIEW');
  pausedInst = await instanceIdByType(brickId, 'BOTTOM_STAMP');

  await prisma.$executeRawUnsafe(
    `UPDATE bounty_instances SET status = 'CLOSED', closed_at = NOW() WHERE id = $1::uuid`, closedInst
  );
  await prisma.$executeRawUnsafe(
    `UPDATE bounty_instances SET status = 'PAUSED' WHERE id = $1::uuid`, pausedInst
  );
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(
    `DELETE FROM user_bounty_stats WHERE user_id = ANY($1::bigint[])`,
    myUserIds.map((id) => BigInt(id))
  );
  await cleanup();
});

describe('POST /api/bounties/:bountyInstanceId/submissions', () => {
  test('401 when unauthenticated', async () => {
    const res = await postSubmission(null, imgInst, { submissionType: 'IMAGE', contentUrl: IMG_URL });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/unauthenticated/i);
  });

  test('201 for a valid IMAGE submission; rewards captured on the row', async () => {
    const res = await postSubmission(verified.token, imgInst, {
      submissionType: 'IMAGE', contentUrl: IMG_URL, notes: 'front packaging',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.submission).toMatchObject({
      status: 'PENDING',
      submissionType: 'IMAGE',
      bountyInstanceId: imgInst,
      contentUrl: IMG_URL,
      rewardCashCents: 75, // PACKAGING_BACK
      rewardCredits: 75,
      rewardXp: 15,        // HIGH
    });
  });

  test('IMAGE submission captures the durable content_path (bare object key, not a signed URL)', async () => {
    const PATH = `${verified.userId}/durable-object-uuid.png`;
    const res = await postSubmission(verified.token, imgInst, {
      submissionType: 'IMAGE', contentUrl: IMG_URL, contentPath: PATH,
    });
    expect(res.status).toBe(201);
    const row = await prisma.$queryRawUnsafe(
      `SELECT content_path FROM bounty_submissions WHERE id = $1::uuid`,
      res.body.data.submission.id
    );
    expect(row[0].content_path).toBe(PATH);                 // durable key persisted
    expect(row[0].content_path).not.toMatch(/^https?:|token=/); // not the signed URL
  });

  test('201 for a valid DATA submission', async () => {
    const res = await postSubmission(verified.token, dataInst, {
      submissionType: 'DATA', contentText: '2023', sourceUrl: 'https://ref.example',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.submission.status).toBe('PENDING');
    expect(res.body.data.submission.submissionType).toBe('DATA');
  });

  test('403 for an unverified email on an IMAGE submission — same shape as the 2.1 upload gate', async () => {
    const submitRes = await postSubmission(unverified.token, imgInst, {
      submissionType: 'IMAGE', contentUrl: IMG_URL,
    });
    expect(submitRes.status).toBe(403);
    expect(submitRes.body).toEqual({ success: false, message: expect.any(String) });

    // Consistency: the 2.1 upload endpoint answers the identical account/email
    // state with the identical envelope + status.
    const uploadRes = await request(app)
      .post('/api/uploads/bounty-image')
      .set('Authorization', `Bearer ${unverified.token}`);
    expect(uploadRes.status).toBe(403);
    expect(uploadRes.body).toEqual({ success: false, message: expect.any(String) });
  });

  test('403 for a read_only account', async () => {
    const res = await postSubmission(readonly.token, imgInst, {
      submissionType: 'IMAGE', contentUrl: IMG_URL,
    });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test('429 when the daily submission limit is reached', async () => {
    const res = await postSubmission(limited.token, imgInst, {
      submissionType: 'IMAGE', contentUrl: IMG_URL,
    });
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/daily|reset|limit/i);
  });

  test('404 for a nonexistent bounty instance', async () => {
    const res = await postSubmission(verified.token, NONEXISTENT_UUID, {
      submissionType: 'IMAGE', contentUrl: IMG_URL,
    });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('409 for a paused bounty', async () => {
    const res = await postSubmission(verified.token, pausedInst, {
      submissionType: 'IMAGE', contentUrl: IMG_URL,
    });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test('422 with errors when IMAGE is missing contentUrl', async () => {
    const res = await postSubmission(verified.token, imgInst, { submissionType: 'IMAGE' });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.errors).toHaveProperty('contentUrl');
  });

  test('422 with errors when DATA is missing contentText', async () => {
    const res = await postSubmission(verified.token, dataInst, { submissionType: 'DATA' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('contentText');
  });

  test('422 with errors for an invalid submissionType', async () => {
    const res = await postSubmission(verified.token, imgInst, { submissionType: 'VIDEO', contentUrl: IMG_URL });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('submissionType');
  });

  test('CLOSED bounty auto-rejects: 200 with the REJECTED row (Already exists)', async () => {
    const res = await postSubmission(verified.token, closedInst, {
      submissionType: 'IMAGE', contentUrl: IMG_URL,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.submission.status).toBe('REJECTED');
    expect(res.body.data.submission.rejectionReasons).toEqual(['Already exists']);
  });
});
