'use strict';

const {
  prisma, createUser, createBrick, cleanup, instanceIdByType, statsFor,
} = require('./helpers');
const Inst = require('../../../src/services/bounties/BountyInstanceService');
const Sub = require('../../../src/services/bounties/BountySubmissionService');

afterAll(cleanup);

async function freshBrickWithBounties(fields = {}) {
  const brickId = await createBrick({ fields });
  const brick = await Inst.getBrickForGeneration(prisma, brickId);
  await Inst.generateForBrick(prisma, brick);
  return brickId;
}

describe('BountySubmissionService.submit (DB)', () => {
  test('captures rewards at submission time and records PENDING (HIGH = 15 XP)', async () => {
    const userId = await createUser({ verified: true });
    const brickId = await freshBrickWithBounties();
    const instId = await instanceIdByType(brickId, 'PACKAGING_BACK');

    const sub = await Sub.submit(prisma, {
      userId, bountyInstanceId: instId, submissionType: 'IMAGE', contentUrl: 'https://x/p.png',
    });

    expect(sub.status).toBe('PENDING');
    expect(sub.cash_reward_cents).toBe(75);
    expect(sub.credit_reward).toBe(75);
    expect(sub.xp_reward).toBe(15);

    const st = await statsFor(userId);
    expect(st.total_submissions).toBe(1);
    expect(st.pending_submissions).toBe(1);
    expect(st.daily_submission_count).toBe(1);
  });

  test('DATA submission to a MEDIUM bounty captures 10 XP', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const instId = await instanceIdByType(brickId, 'RELEASE_YEAR');

    const sub = await Sub.submit(prisma, {
      userId, bountyInstanceId: instId, submissionType: 'DATA', contentText: '2023',
    });
    expect(sub).toMatchObject({ status: 'PENDING', cash_reward_cents: 15, credit_reward: 15, xp_reward: 10 });
  });

  test('blocks a read_only user (account_state gate)', async () => {
    const userId = await createUser({ accountState: 'read_only' });
    const brickId = await freshBrickWithBounties();
    const instId = await instanceIdByType(brickId, 'PACKAGING_BACK');
    await expect(Sub.submit(prisma, {
      userId, bountyInstanceId: instId, submissionType: 'IMAGE', contentUrl: 'https://x/p.png',
    })).rejects.toMatchObject({ code: 'account_read_only' });
  });

  test('IMAGE requires verified email; DATA does not', async () => {
    const userId = await createUser({ verified: false });
    const brickId = await freshBrickWithBounties();
    const imgInst = await instanceIdByType(brickId, 'PACKAGING_BACK');
    const dataInst = await instanceIdByType(brickId, 'RELEASE_YEAR');

    await expect(Sub.submit(prisma, {
      userId, bountyInstanceId: imgInst, submissionType: 'IMAGE', contentUrl: 'https://x/p.png',
    })).rejects.toMatchObject({ code: 'email_not_verified' });

    const ok = await Sub.submit(prisma, {
      userId, bountyInstanceId: dataInst, submissionType: 'DATA', contentText: 'lottery release',
    });
    expect(ok.status).toBe('PENDING');
  });

  test('requires the content matching the submission type', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const instId = await instanceIdByType(brickId, 'PACKAGING_BACK');
    await expect(Sub.submit(prisma, { userId, bountyInstanceId: instId, submissionType: 'IMAGE' }))
      .rejects.toMatchObject({ code: 'missing_content_url' });
    await expect(Sub.submit(prisma, { userId, bountyInstanceId: instId, submissionType: 'DATA' }))
      .rejects.toMatchObject({ code: 'missing_content_text' });
  });

  test('auto-rejects "Already exists" on a CLOSED bounty, and it still counts (Q14)', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const instId = await instanceIdByType(brickId, 'PACKAGING_BACK');
    await prisma.$executeRawUnsafe(
      `UPDATE bounty_instances SET status = 'CLOSED', closed_at = NOW() WHERE id = $1::uuid`, instId);

    const sub = await Sub.submit(prisma, {
      userId, bountyInstanceId: instId, submissionType: 'IMAGE', contentUrl: 'https://x/p.png',
    });
    expect(sub.status).toBe('REJECTED');
    expect(sub.cash_reward_cents).toBe(0);
    expect(sub.credit_reward).toBe(0);
    expect(sub.xp_reward).toBe(0);

    const st = await statsFor(userId);
    expect(st.rejected_submissions).toBe(1);
    expect(st.daily_submission_count).toBe(1);
    expect(Number(st.approval_rate)).toBe(0); // 0 accepted / 1 reviewed
  });

  test('blocks a PAUSED bounty without creating a row', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const instId = await instanceIdByType(brickId, 'SIDE_VIEW');
    await prisma.$executeRawUnsafe(`UPDATE bounty_instances SET status = 'PAUSED' WHERE id = $1::uuid`, instId);
    await expect(Sub.submit(prisma, {
      userId, bountyInstanceId: instId, submissionType: 'IMAGE', contentUrl: 'https://x/p.png',
    })).rejects.toMatchObject({ code: 'bounty_paused' });
    expect(await statsFor(userId)).toBeNull(); // nothing recorded
  });

  test('enforces the 10/day limit, counting all outcomes (Q14)', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const instId = await instanceIdByType(brickId, 'PACKAGING_BACK');

    for (let n = 0; n < 10; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Sub.submit(prisma, {
        userId, bountyInstanceId: instId, submissionType: 'IMAGE', contentUrl: 'https://x/p.png',
      });
    }
    await expect(Sub.submit(prisma, {
      userId, bountyInstanceId: instId, submissionType: 'IMAGE', contentUrl: 'https://x/p.png',
    })).rejects.toMatchObject({ code: 'daily_limit_reached' });

    const st = await statsFor(userId);
    expect(st.daily_submission_count).toBe(10);
    expect(st.total_submissions).toBe(10);
  });
});
