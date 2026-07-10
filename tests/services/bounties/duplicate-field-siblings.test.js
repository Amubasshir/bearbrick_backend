'use strict';

// Unit B2 (step 1) — the canonical duplicate-field detector primitive:
// BountySubmissionService.findApprovedUnappliedSiblings. A "sibling" is a
// submission in the rewarded-but-not-yet-applied window (status = APPROVED)
// whose bounty instance targets the SAME brick_id AND SAME target_field,
// excluding the submission in question. brick_id lives on the submission row;
// target_field on its instance, so the detector joins the two.

const {
  prisma, createUser, createBrick, cleanup, instanceIdByType,
} = require('./helpers');
const Inst = require('../../../src/services/bounties/BountyInstanceService');
const Sub = require('../../../src/services/bounties/BountySubmissionService');

const PACK_BACK_COL = 'packaging_back_image_url';
const YEAR_COL = 'release_year';

let userId;

beforeAll(async () => {
  userId = await createUser({ verified: true, tag: 'b2prim' });
});

afterAll(cleanup);

// Fresh brick with generated OPEN instances; returns the two instance ids we use.
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

// Seed a bounty_submissions row directly at an arbitrary status (the detector
// only reads status/brick_id/instance.target_field, so no reward plumbing needed).
async function seedSub(brickId, instanceId, status) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bounty_submissions
       (bounty_instance_id, brick_id, user_id, submission_type, content_url,
        status, created_at, updated_at, cash_reward_cents, credit_reward, xp_reward)
     VALUES ($1::uuid, $2, $3, 'IMAGE', 'https://x/p.png', $4, NOW(), NOW(), 0, 0, 0)
     RETURNING id`,
    instanceId, brickId, BigInt(userId), status
  );
  return rows[0].id;
}

describe('BountySubmissionService.findApprovedUnappliedSiblings', () => {
  test('returns the sibling when an APPROVED-unapplied one exists for the same brick+field', async () => {
    const b = await freshBrick('b2p-has');
    const sib = await seedSub(b.brickId, b.instBack, 'APPROVED');

    const ids = await Sub.findApprovedUnappliedSiblings(prisma, {
      brickId: b.brickId, targetField: PACK_BACK_COL,
    });
    expect(ids).toEqual([sib]);
  });

  test('empty when no APPROVED-unapplied submission exists', async () => {
    const b = await freshBrick('b2p-none');
    const ids = await Sub.findApprovedUnappliedSiblings(prisma, {
      brickId: b.brickId, targetField: PACK_BACK_COL,
    });
    expect(ids).toEqual([]);
  });

  test('excludes the submission itself', async () => {
    const b = await freshBrick('b2p-self');
    const self = await seedSub(b.brickId, b.instBack, 'APPROVED');
    const ids = await Sub.findApprovedUnappliedSiblings(prisma, {
      brickId: b.brickId, targetField: PACK_BACK_COL, excludeSubmissionId: self,
    });
    expect(ids).toEqual([]); // the only APPROVED row is the one we excluded
  });

  test('does NOT count APPLIED_TO_BRICK, PENDING, or REJECTED as siblings', async () => {
    const b = await freshBrick('b2p-status');
    await seedSub(b.brickId, b.instBack, 'APPLIED_TO_BRICK');
    await seedSub(b.brickId, b.instBack, 'PENDING');
    await seedSub(b.brickId, b.instBack, 'REJECTED');
    const ids = await Sub.findApprovedUnappliedSiblings(prisma, {
      brickId: b.brickId, targetField: PACK_BACK_COL,
    });
    expect(ids).toEqual([]);
  });

  test('scoped to the same field — a different field on the same brick is not a sibling', async () => {
    const b = await freshBrick('b2p-field');
    const backSib = await seedSub(b.brickId, b.instBack, 'APPROVED'); // packaging_back
    const yearSib = await seedSub(b.brickId, b.instYear, 'APPROVED'); // release_year

    const backIds = await Sub.findApprovedUnappliedSiblings(prisma, {
      brickId: b.brickId, targetField: PACK_BACK_COL,
    });
    const yearIds = await Sub.findApprovedUnappliedSiblings(prisma, {
      brickId: b.brickId, targetField: YEAR_COL,
    });
    expect(backIds).toEqual([backSib]); // only the packaging_back one
    expect(yearIds).toEqual([yearSib]); // only the release_year one
  });

  test('scoped to the same brick — an APPROVED sub on a different brick is not a sibling', async () => {
    const a = await freshBrick('b2p-brickA');
    await seedSub(a.brickId, a.instBack, 'APPROVED');
    const other = await freshBrick('b2p-brickB');

    const ids = await Sub.findApprovedUnappliedSiblings(prisma, {
      brickId: other.brickId, targetField: PACK_BACK_COL,
    });
    expect(ids).toEqual([]);
  });
});
