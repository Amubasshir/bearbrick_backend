'use strict';

// A4 money / transaction integration tests (DB). The heaviest coverage in the
// milestone (client priority: money correctness). Covers the approve and
// approve-and-apply transactions, the budget cap, idempotency on both approve
// paths, the payout state machine (reserve / approve / mark-paid double-click
// no-op / reject release / multiple-pending accounting), the signup balance
// hook, and determinism (captured-at-submission rewards).
//
// admin_settings is a global shared row. This suite sets the specific keys it
// depends on to their seeded defaults in beforeAll and resets them explicitly in
// afterAll — it never snapshot/restores the shared row (a restore can re-persist
// another suite's transient value; that pollution vector broke a reader suite once
// and is now closed). In-test mutations (spent / cash_rewards_enabled) are reset
// back to baseline within each test.

const {
  prisma, createUser, createBrick, cleanup, instanceIdByType, setAdminSetting,
  balanceFor, rewardEventsFor, xpEventsFor, payoutsFor, payoutActionsFor, seedBalance, created,
} = require('./helpers');
const Inst = require('../../../src/services/bounties/BountyInstanceService');
const Sub = require('../../../src/services/bounties/BountySubmissionService');
const Approve = require('../../../src/services/bounties/BountyApprovalService');
const ApproveApply = require('../../../src/services/bounties/BountyApprovalAndApplyService');
const Payout = require('../../../src/services/bounties/PayoutService');
const Auth = require('../../../src/services/AuthService');
const MonthlyReset = require('../../../src/scripts/monthly-budget-reset-worker');

beforeAll(async () => {
  // Known baseline so cash assertions are deterministic regardless of dev-DB drift.
  // Set each key explicitly to its seeded default — never snapshot/restore the
  // shared global row (a restore can re-persist another suite's transient value).
  await setAdminSetting('monthly_cash_budget_cents', 50000);
  await setAdminSetting('monthly_cash_spent_cents', 0);
  await setAdminSetting('cash_rewards_enabled', 'true');
  await setAdminSetting('minimum_payout_cents', 1000);
});

afterAll(async () => {
  // Reset every admin_settings key this suite mutates back to its seeded default
  // (explicit narrow resets, not a snapshot replay) so the shared row is left
  // pristine for other suites.
  await setAdminSetting('monthly_cash_budget_cents', 50000);
  await setAdminSetting('monthly_cash_spent_cents', 0);
  await setAdminSetting('cash_rewards_enabled', 'true');
  await setAdminSetting('minimum_payout_cents', 1000);
  await setAdminSetting('monthly_budget_last_reset_period', '');
  await cleanup();
});

async function freshBrickWithBounties(fields = {}) {
  const brickId = await createBrick({ fields });
  const brick = await Inst.getBrickForGeneration(prisma, brickId);
  await Inst.generateForBrick(prisma, brick);
  return brickId;
}

async function submitTo(brickId, type, userId) {
  const instId = await instanceIdByType(brickId, type);
  const isImage = type.startsWith('PACKAGING') || type === 'BACK_OF_FIGURE'
    || type === 'SIDE_VIEW' || type === 'BOTTOM_STAMP';
  return Sub.submit(prisma, {
    userId,
    bountyInstanceId: instId,
    submissionType: isImage ? 'IMAGE' : 'DATA',
    contentUrl: isImage ? 'https://x/p.png' : null,
    contentText: isImage ? null : '2023',
  });
}

// ---------------------------------------------------------------------------
// Simple Approve
// ---------------------------------------------------------------------------
describe('BountyApprovalService.approve', () => {
  test('credits cash + credits + lifetime, mints XP, bumps stats and monthly-spent', async () => {
    const admin = await createUser();
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const sub = await submitTo(brickId, 'PACKAGING_BACK', userId); // HIGH: 75c / 75cr / 15xp

    const spentBefore = parseInt((await prisma.$queryRawUnsafe(
      `SELECT value FROM admin_settings WHERE key = 'monthly_cash_spent_cents'`))[0].value, 10);

    const res = await Approve.approve(prisma, { submissionId: sub.id, adminUserId: admin });
    expect(res.idempotent).toBe(false);
    expect(res.actualCash).toBe(75);
    expect(res.creditReward).toBe(75);
    expect(res.xpReward).toBe(15);
    expect(res.submission.status).toBe('APPROVED');

    const bal = await balanceFor(userId);
    expect(bal.cash_balance_cents).toBe(75);
    expect(bal.credit_balance).toBe(75);
    expect(bal.lifetime_cash_earned_cents).toBe(75);
    expect(bal.lifetime_credits_earned).toBe(75);

    const ledger = await rewardEventsFor(userId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].event_type).toBe('BOUNTY_APPROVED');
    expect(ledger[0].idempotency_key).toBe(`bounty_reward:${sub.id}:approved`);
    expect(ledger[0].cash_delta_cents).toBe(75);

    const xp = await xpEventsFor(userId);
    const types = xp.map((e) => e.event_type);
    expect(types).toContain('BOUNTY_SUBMISSION_APPROVED');
    expect(types).toContain('FIRST_APPROVED_BOUNTY'); // 1st accepted
    expect(xp.every((e) => e.reason === 'CONTRIBUTION')).toBe(true);

    const stats = await prisma.$queryRawUnsafe(
      `SELECT * FROM user_bounty_stats WHERE user_id = $1`, BigInt(userId));
    expect(stats[0].accepted_submissions).toBe(1);
    expect(stats[0].pending_submissions).toBe(0);

    const spentAfter = parseInt((await prisma.$queryRawUnsafe(
      `SELECT value FROM admin_settings WHERE key = 'monthly_cash_spent_cents'`))[0].value, 10);
    expect(spentAfter - spentBefore).toBe(75);

    // Simple Approve does NOT close the bounty.
    expect(await Inst.countOpenForBrick(prisma, brickId)).toBeGreaterThan(0);

    await setAdminSetting('monthly_cash_spent_cents', 0); // keep file baseline clean
  });

  test('retry is idempotent — no double pay, no second ledger row', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const sub = await submitTo(brickId, 'PACKAGING_FRONT', userId); // 50c / 50cr / 15xp

    await Approve.approve(prisma, { submissionId: sub.id });
    const again = await Approve.approve(prisma, { submissionId: sub.id });
    expect(again.idempotent).toBe(true);

    const bal = await balanceFor(userId);
    expect(bal.cash_balance_cents).toBe(50); // paid once
    expect(bal.credit_balance).toBe(50);
    expect(await rewardEventsFor(userId)).toHaveLength(1);

    await setAdminSetting('monthly_cash_spent_cents', 0);
  });

  test('budget cap (Q6): $0 cash but full credits + full XP', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const sub = await submitTo(brickId, 'BOTTOM_STAMP', userId); // 50c / 50cr / 15xp

    // Exhaust the monthly budget so spent + captured > budget.
    await setAdminSetting('monthly_cash_spent_cents', 50000);

    const res = await Approve.approve(prisma, { submissionId: sub.id });
    expect(res.actualCash).toBe(0);
    expect(res.creditReward).toBe(50);
    expect(res.xpReward).toBe(15);

    const bal = await balanceFor(userId);
    expect(bal.cash_balance_cents).toBe(0);
    expect(bal.credit_balance).toBe(50);
    expect(bal.lifetime_cash_earned_cents).toBe(0);
    expect(bal.lifetime_credits_earned).toBe(50);

    const ledger = await rewardEventsFor(userId);
    expect(ledger[0].cash_delta_cents).toBe(0);
    expect(ledger[0].credit_delta).toBe(50);
    expect(ledger[0].xp_delta).toBe(15);

    const xpTypes = (await xpEventsFor(userId)).map((e) => e.event_type);
    expect(xpTypes).toContain('BOUNTY_SUBMISSION_APPROVED');

    await setAdminSetting('monthly_cash_spent_cents', 0);
  });

  test('cash_rewards_enabled=false zeroes cash, keeps credits + XP', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const sub = await submitTo(brickId, 'SIDE_VIEW', userId); // 25c / 25cr / 10xp

    await setAdminSetting('cash_rewards_enabled', 'false');
    const res = await Approve.approve(prisma, { submissionId: sub.id });
    await setAdminSetting('cash_rewards_enabled', 'true');

    expect(res.actualCash).toBe(0);
    expect(res.creditReward).toBe(25);
    const bal = await balanceFor(userId);
    expect(bal.cash_balance_cents).toBe(0);
    expect(bal.credit_balance).toBe(25);
  });

  test('determinism: approve pays the captured submission-row reward, not the live definition', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const sub = await submitTo(brickId, 'RELEASE_METHOD', userId);

    // Simulate a definition change AFTER submission by mutating only the captured
    // row to distinctive values. approve must use these, never re-read the def.
    await prisma.$executeRawUnsafe(
      `UPDATE bounty_submissions SET cash_reward_cents = 999, credit_reward = 888, xp_reward = 7 WHERE id = $1::uuid`,
      sub.id
    );

    const res = await Approve.approve(prisma, { submissionId: sub.id });
    expect(res.actualCash).toBe(999);
    expect(res.creditReward).toBe(888);
    expect(res.xpReward).toBe(7);
    const bal = await balanceFor(userId);
    expect(bal.cash_balance_cents).toBe(999);
    expect(bal.credit_balance).toBe(888);

    await setAdminSetting('monthly_cash_spent_cents', 0);
  });

  test('the 10th accepted bounty mints TEN_APPROVED_BOUNTIES (and the 1st FIRST)', async () => {
    const userId = await createUser();
    const subIds = [];
    for (let n = 0; n < 10; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const brickId = await freshBrickWithBounties();
      // eslint-disable-next-line no-await-in-loop
      const sub = await submitTo(brickId, 'RELEASE_YEAR', userId); // DATA, low daily pressure
      subIds.push(sub.id);
    }
    for (const id of subIds) {
      // eslint-disable-next-line no-await-in-loop
      await Approve.approve(prisma, { submissionId: id });
    }
    const xpTypes = (await xpEventsFor(userId)).map((e) => e.event_type);
    expect(xpTypes.filter((t) => t === 'FIRST_APPROVED_BOUNTY')).toHaveLength(1);
    expect(xpTypes.filter((t) => t === 'TEN_APPROVED_BOUNTIES')).toHaveLength(1);

    await setAdminSetting('monthly_cash_spent_cents', 0);
  });
});

// ---------------------------------------------------------------------------
// Approve + Apply
// ---------------------------------------------------------------------------
describe('BountyApprovalAndApplyService.approveAndApply', () => {
  test('writes the canonical brick field, closes the bounty, APPLIED_TO_BRICK', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const sub = await submitTo(brickId, 'RELEASE_YEAR', userId);

    const res = await ApproveApply.approveAndApply(prisma, { submissionId: sub.id });
    expect(res.submission.status).toBe('APPLIED_TO_BRICK');
    expect(res.brickClosed).toBe(true);

    const brick = await Inst.getBrickForGeneration(prisma, brickId);
    expect(brick.release_year).toBe(2023);

    const inst = await prisma.$queryRawUnsafe(
      `SELECT status FROM bounty_instances WHERE id = $1::uuid`, sub.bounty_instance_id);
    expect(inst[0].status).toBe('CLOSED');

    const ledger = await rewardEventsFor(userId);
    expect(ledger[0].event_type).toBe('BOUNTY_APPROVED_AND_APPLIED');
    expect(ledger[0].idempotency_key).toBe(`bounty_reward:${sub.id}:approved_and_applied`);

    await setAdminSetting('monthly_cash_spent_cents', 0);
  });

  test('BRICK_COMPLETED fires only when the apply closes the brick\'s last OPEN bounty (Q7)', async () => {
    const userId = await createUser();
    // Brick with a single missing field => exactly one bounty.
    const brickId = await createBrick({
      fields: {
        packaging_front_image_url: 'a', packaging_back_image_url: 'b', back_image_url: 'c',
        side_image_url: 'd', bottom_stamp_image_url: 'e', release_method: 'lottery', notes: 'n',
        // release_year left null => one bounty
      },
    });
    const brick = await Inst.getBrickForGeneration(prisma, brickId);
    await Inst.generateForBrick(prisma, brick);
    expect(await Inst.countOpenForBrick(prisma, brickId)).toBe(1);

    const instId = await instanceIdByType(brickId, 'RELEASE_YEAR');
    const sub = await Sub.submit(prisma, {
      userId, bountyInstanceId: instId, submissionType: 'DATA', contentText: '2021',
    });

    const res = await ApproveApply.approveAndApply(prisma, { submissionId: sub.id });
    expect(res.brickClosed).toBe(true);
    expect(res.brickCompleted).toBe(true);

    const xpTypes = (await xpEventsFor(userId)).map((e) => e.event_type);
    expect(xpTypes).toContain('BRICK_COMPLETED');

    await setAdminSetting('monthly_cash_spent_cents', 0);
  });

  test('BRICK_COMPLETED does NOT fire while other OPEN bounties remain', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties(); // all 8 fields null => 8 bounties
    const sub = await submitTo(brickId, 'RELEASE_YEAR', userId);

    const res = await ApproveApply.approveAndApply(prisma, { submissionId: sub.id });
    expect(res.brickClosed).toBe(true);
    expect(res.brickCompleted).toBe(false);
    expect(await Inst.countOpenForBrick(prisma, brickId)).toBe(7);

    const xpTypes = (await xpEventsFor(userId)).map((e) => e.event_type);
    expect(xpTypes).not.toContain('BRICK_COMPLETED');

    await setAdminSetting('monthly_cash_spent_cents', 0);
  });

  test('approve-and-apply retry is idempotent', async () => {
    const userId = await createUser();
    const brickId = await freshBrickWithBounties();
    const sub = await submitTo(brickId, 'NOTES_CONTEXT', userId);

    await ApproveApply.approveAndApply(prisma, { submissionId: sub.id });
    const again = await ApproveApply.approveAndApply(prisma, { submissionId: sub.id });
    expect(again.idempotent).toBe(true);
    expect(await rewardEventsFor(userId)).toHaveLength(1);

    await setAdminSetting('monthly_cash_spent_cents', 0);
  });
});

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------
describe('PayoutService', () => {
  test('request reserves cash; below-minimum and over-available are rejected', async () => {
    const userId = await createUser();
    await seedBalance(userId, { cash: 5000 }); // $50 available

    await expect(Payout.request(prisma, {
      userId, amountCents: 500, payoutMethod: 'PAYPAL', payoutHandle: 'a@b.com',
    })).rejects.toMatchObject({ code: 'below_minimum_payout' });

    await expect(Payout.request(prisma, {
      userId, amountCents: 6000, payoutMethod: 'PAYPAL', payoutHandle: 'a@b.com',
    })).rejects.toMatchObject({ code: 'insufficient_available_cash' });

    const pr = await Payout.request(prisma, {
      userId, amountCents: 3000, payoutMethod: 'PAYPAL', payoutHandle: 'a@b.com',
    });
    expect(pr.status).toBe('REQUESTED');
    const bal = await balanceFor(userId);
    expect(bal.reserved_cash_cents).toBe(3000);
    expect(bal.cash_balance_cents).toBe(5000); // cash not moved until PAID

    const actions = await payoutActionsFor(pr.id);
    expect(actions.map((a) => a.action)).toContain('REQUESTED');
  });

  test('approve -> mark-paid moves cash and reserved down; double mark-paid is a no-op (Q9)', async () => {
    const admin = await createUser();
    const userId = await createUser();
    await seedBalance(userId, { cash: 5000 });
    const pr = await Payout.request(prisma, {
      userId, amountCents: 3000, payoutMethod: 'VENMO', payoutHandle: '@x',
    });

    await Payout.approve(prisma, { payoutRequestId: pr.id, adminUserId: admin });
    const paid = await Payout.markPaid(prisma, { payoutRequestId: pr.id, adminUserId: admin });
    expect(paid.idempotent).toBe(false);
    expect(paid.payout.status).toBe('PAID');

    let bal = await balanceFor(userId);
    expect(bal.cash_balance_cents).toBe(2000); // 5000 - 3000
    expect(bal.reserved_cash_cents).toBe(0); // 3000 - 3000

    // Second mark-paid: no balance change, idempotent.
    const dbl = await Payout.markPaid(prisma, { payoutRequestId: pr.id, adminUserId: admin });
    expect(dbl.idempotent).toBe(true);
    bal = await balanceFor(userId);
    expect(bal.cash_balance_cents).toBe(2000);
    expect(bal.reserved_cash_cents).toBe(0);

    const actions = await payoutActionsFor(pr.id);
    expect(actions.filter((a) => a.action === 'PAID')).toHaveLength(1);
    expect(actions.find((a) => a.action === 'PAID').idempotency_key).toBe(`payout_paid:${pr.id}`);
  });

  test('markPaid requires APPROVED: a REQUESTED payout cannot be paid (Jake item 1)', async () => {
    const userId = await createUser();
    await seedBalance(userId, { cash: 5000 });
    const pr = await Payout.request(prisma, {
      userId, amountCents: 3000, payoutMethod: 'PAYPAL', payoutHandle: 'a@b.com',
    });
    // Requested -> Approved -> Paid is enforced: markPaid on a REQUESTED throws.
    await expect(Payout.markPaid(prisma, { payoutRequestId: pr.id }))
      .rejects.toMatchObject({ code: 'cannot_pay_requested' });
    // No money moved; still REQUESTED with the reserve intact.
    const bal = await balanceFor(userId);
    expect(bal.cash_balance_cents).toBe(5000);
    expect(bal.reserved_cash_cents).toBe(3000);
  });

  test('reject releases the reserve, leaves cash untouched', async () => {
    const userId = await createUser();
    await seedBalance(userId, { cash: 5000 });
    const pr = await Payout.request(prisma, {
      userId, amountCents: 2500, payoutMethod: 'PAYPAL', payoutHandle: 'a@b.com',
    });
    const rej = await Payout.reject(prisma, { payoutRequestId: pr.id, notes: 'bad handle' });
    expect(rej.payout.status).toBe('REJECTED');

    const bal = await balanceFor(userId);
    expect(bal.reserved_cash_cents).toBe(0);
    expect(bal.cash_balance_cents).toBe(5000);
  });

  test('multiple pending payouts each reserve separately (Q10)', async () => {
    const userId = await createUser();
    await seedBalance(userId, { cash: 10000 });
    const p1 = await Payout.request(prisma, {
      userId, amountCents: 3000, payoutMethod: 'PAYPAL', payoutHandle: 'a@b.com',
    });
    const p2 = await Payout.request(prisma, {
      userId, amountCents: 4000, payoutMethod: 'PAYPAL', payoutHandle: 'a@b.com',
    });
    let bal = await balanceFor(userId);
    expect(bal.reserved_cash_cents).toBe(7000); // both reserved

    // A third request that exceeds available (10000 - 7000 = 3000) is blocked.
    await expect(Payout.request(prisma, {
      userId, amountCents: 3500, payoutMethod: 'PAYPAL', payoutHandle: 'a@b.com',
    })).rejects.toMatchObject({ code: 'insufficient_available_cash' });

    // Pay the first (approve -> mark-paid), reject the second: cash -3000, reserved back to 0.
    await Payout.approve(prisma, { payoutRequestId: p1.id });
    await Payout.markPaid(prisma, { payoutRequestId: p1.id });
    await Payout.reject(prisma, { payoutRequestId: p2.id });
    bal = await balanceFor(userId);
    expect(bal.cash_balance_cents).toBe(7000); // 10000 - 3000
    expect(bal.reserved_cash_cents).toBe(0);

    const all = await payoutsFor(userId);
    expect(all).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Signup hook (D3 / Q12)
// ---------------------------------------------------------------------------
describe('AuthService.signup balance hook', () => {
  test('creates exactly one user_balances row atomically on signup', async () => {
    const email = `m4_signup_${Date.now()}_${Math.floor(Math.random() * 1e6)}@m4.test`;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret';
    const res = await Auth.signup('Signup User', email, 'password123', false);
    expect(res.success).toBe(true);

    const userId = BigInt(res.data.user.id);
    created.userIds.push(userId); // ensure afterAll cleanup removes it

    const bal = await balanceFor(userId);
    expect(bal).not.toBeNull();
    expect(bal.cash_balance_cents).toBe(0);
    expect(bal.reserved_cash_cents).toBe(0);
    expect(bal.credit_balance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// monthly-budget-reset-worker — lives here (not in tests/workers) because it
// mutates the same GLOBAL admin_settings rows this file already owns via its
// explicit baseline/reset. Keeping it single-file avoids a cross-file race under
// jest's default parallel test-file execution. The remaining two A5 workers are
// per-entity and tested in tests/workers/bounty-workers-integration.test.js.
// ---------------------------------------------------------------------------
describe('monthly-budget-reset-worker', () => {
  async function getSetting(key) {
    const r = await prisma.$queryRawUnsafe(`SELECT value FROM admin_settings WHERE key = $1`, key);
    return r[0] ? r[0].value : null;
  }

  test('resets spent to 0, re-enables cash, and stamps the month marker', async () => {
    await setAdminSetting('monthly_budget_last_reset_period', '2000-01'); // a stale month
    await setAdminSetting('monthly_cash_spent_cents', 12345);
    await setAdminSetting('cash_rewards_enabled', 'false');

    const res = await MonthlyReset.processOneTick(prisma, { nowUtc: new Date(Date.UTC(2026, 5, 15)) });
    expect(res).toEqual({ reset: true, period: '2026-06' });

    expect(await getSetting('monthly_cash_spent_cents')).toBe('0');
    expect(await getSetting('cash_rewards_enabled')).toBe('true');
    expect(await getSetting('monthly_budget_last_reset_period')).toBe('2026-06');
  });

  test('a second tick in the same month is a no-op (does not clobber spent)', async () => {
    // Marker is '2026-06' from the previous test. Put a sentinel spend back.
    await setAdminSetting('monthly_cash_spent_cents', 777);

    const res = await MonthlyReset.processOneTick(prisma, { nowUtc: new Date(Date.UTC(2026, 5, 28)) });
    expect(res).toEqual({ reset: false, period: '2026-06' });
    expect(await getSetting('monthly_cash_spent_cents')).toBe('777'); // untouched

    await setAdminSetting('monthly_cash_spent_cents', 0); // restore file baseline
  });
});
