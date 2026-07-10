'use strict';

// Unit 3.7 — PATCH /api/admin/bounty-definitions/:id (adjust rewards / pause a
// bounty type globally; flag can_manage_settings). PATCH partial semantics: only
// provided fields change. Editable set is grounded in the REAL columns —
// reward_cash_cents, reward_credits, priority (the only lever for the derived XP,
// since there is no xp column), and is_active. `type` is identity/derivation and
// is rejected. Money edits are FORWARD-ONLY: rewards are captured onto submission
// rows at submission time, so a definition edit never touches already-submitted
// captured amounts.
//
// admin_settings/definition discipline: every mutation test uses a THROWAWAY
// definition (novel unique type, deleted in afterAll). No seeded MVP definition is
// ever left altered (that would race the definition-reader suites).

const request = require('supertest');
const { app, createFreshAdmin, createFreshUser, adminReq } = require('../helpers/dex');
const {
  prisma, createUser, createBrick, cleanup,
} = require('../services/bounties/helpers');
const Sub = require('../../src/services/bounties/BountySubmissionService');

const url = (id) => `/api/admin/bounty-definitions/${id}`;
const DUMMY_UUID = '11111111-1111-4111-8111-999999999999';

let admin;
let plain;
const throwawayDefIds = [];
let defSeq = 0;

async function makeDef({ cash = 50, credits = 50, priority = 'MEDIUM', active = true } = {}) {
  const type = `TEST_PATCH_${Date.now()}_${++defSeq}`;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO bounty_definitions
       (type, display_name, description, reward_cash_cents, reward_credits, priority, is_active)
     VALUES ($1, 'Test Patch Def', 'desc', $2, $3, $4, $5) RETURNING id`,
    type, cash, credits, priority, active
  );
  throwawayDefIds.push(rows[0].id);
  return rows[0].id;
}

async function defRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT reward_cash_cents, reward_credits, priority, is_active
     FROM bounty_definitions WHERE id = $1::uuid`, id);
  return rows[0];
}

beforeAll(async () => {
  admin = await createFreshAdmin('u37admin');
  plain = await createFreshUser('u37plain');
});

afterAll(async () => {
  // Remove any instances/submissions on tracked bricks FIRST (FK RESTRICT), then
  // the throwaway definitions they referenced.
  await cleanup();
  if (throwawayDefIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM bounty_definitions WHERE id = ANY($1::uuid[])`, throwawayDefIds);
  }
});

describe('PATCH /api/admin/bounty-definitions/:id — auth (both paths)', () => {
  test('401 when unauthenticated', async () => {
    const id = await makeDef();
    const res = await request(app).patch(url(id)).send({ rewardCashCents: 10 });
    expect(res.status).toBe(401);
  });

  test('403 for a non-admin JWT (through requirePermission can_manage_settings)', async () => {
    const id = await makeDef();
    const res = await request(app).patch(url(id))
      .set('Authorization', `Bearer ${plain.token}`).send({ rewardCashCents: 10 });
    expect(res.status).toBe(403);
  });

  test('200 via admin JWT (hasPermission path)', async () => {
    const id = await makeDef({ cash: 50 });
    const res = await request(app).patch(url(id))
      .set('Authorization', `Bearer ${admin.token}`).send({ rewardCashCents: 60 });
    expect(res.status).toBe(200);
    expect(res.body.data.definition.rewardCashCents).toBe(60);
  });

  test('200 via X-Admin-Secret (transport path)', async () => {
    const id = await makeDef({ cash: 50 });
    const res = await adminReq().patch(url(id)).send({ rewardCashCents: 70 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('PATCH /api/admin/bounty-definitions/:id — behavior', () => {
  test('adjusts reward amounts (partial): only provided fields change', async () => {
    const id = await makeDef({ cash: 50, credits: 50, priority: 'MEDIUM' });
    const res = await adminReq().patch(url(id)).send({ rewardCashCents: 125, rewardCredits: 200 });
    expect(res.status).toBe(200);
    expect(res.body.data.definition).toMatchObject({
      rewardCashCents: 125, rewardCredits: 200, priority: 'MEDIUM',
    });

    const row = await defRow(id);
    expect(row.reward_cash_cents).toBe(125);
    expect(row.reward_credits).toBe(200);
    expect(row.priority).toBe('MEDIUM'); // untouched
    expect(row.is_active).toBe(true);    // untouched
  });

  test('pauses a bounty type globally via is_active:false', async () => {
    const id = await makeDef({ active: true });
    const res = await adminReq().patch(url(id)).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.definition.isActive).toBe(false);
    expect((await defRow(id)).is_active).toBe(false);
    // generateForBrick's is_active=TRUE filtering (the actual pause effect) is
    // already covered at the service layer in Phase A.
  });

  test('editing priority changes the tier (drives derived XP for future submissions)', async () => {
    const id = await makeDef({ priority: 'LOW' });
    const res = await adminReq().patch(url(id)).send({ priority: 'HIGH' });
    expect(res.status).toBe(200);
    expect(res.body.data.definition.priority).toBe('HIGH');
    expect((await defRow(id)).priority).toBe('HIGH');
  });

  test('FORWARD-ONLY: editing rewards does NOT change an already-submitted captured amount', async () => {
    const brickId = await createBrick({ tag: 'u37cap' });
    const defId = await makeDef({ cash: 100, credits: 100, priority: 'MEDIUM' });
    // Manual OPEN instance for the throwaway def (generateForBrick only covers
    // FIELD_MAP types). target_field is arbitrary here — capture is what matters.
    const instRows = await prisma.$queryRawUnsafe(
      `INSERT INTO bounty_instances (brick_id, bounty_definition_id, target_field, status, created_by)
       VALUES ($1, $2::uuid, 'notes', 'OPEN', 'TEST') RETURNING id`,
      brickId, defId);
    const instanceId = instRows[0].id;

    const userId = await createUser({ verified: true, tag: 'u37cap' });
    const sub = await Sub.submit(prisma, {
      userId, bountyInstanceId: instanceId, submissionType: 'DATA', contentText: 'x',
    });
    expect(sub.cash_reward_cents).toBe(100); // captured at submission time

    // Change the definition's rewards afterward.
    const res = await adminReq().patch(url(defId)).send({ rewardCashCents: 999, rewardCredits: 999 });
    expect(res.status).toBe(200);

    // The already-submitted row keeps its captured amount.
    const after = await prisma.$queryRawUnsafe(
      `SELECT cash_reward_cents, credit_reward FROM bounty_submissions WHERE id = $1::uuid`, sub.id);
    expect(after[0].cash_reward_cents).toBe(100);
    expect(after[0].credit_reward).toBe(100);
  });

  test('404 when the definition does not exist', async () => {
    const res = await adminReq().patch(url(DUMMY_UUID)).send({ rewardCashCents: 10 });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/admin/bounty-definitions/:id — validation (422)', () => {
  test('empty body / no editable fields -> 422', async () => {
    const id = await makeDef();
    const res = await adminReq().patch(url(id)).send({});
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  test('negative reward -> 422 with errors', async () => {
    const id = await makeDef();
    const res = await adminReq().patch(url(id)).send({ rewardCashCents: -5 });
    expect(res.status).toBe(422);
    expect(res.body.errors.rewardCashCents).toBeDefined();
    expect((await defRow(id)).reward_cash_cents).toBe(50); // unchanged
  });

  test('non-integer cents -> 422 with errors', async () => {
    const id = await makeDef();
    const res = await adminReq().patch(url(id)).send({ rewardCashCents: 12.5 });
    expect(res.status).toBe(422);
    expect(res.body.errors.rewardCashCents).toBeDefined();
  });

  test('invalid priority value -> 422', async () => {
    const id = await makeDef();
    const res = await adminReq().patch(url(id)).send({ priority: 'URGENT' });
    expect(res.status).toBe(422);
    expect(res.body.errors.priority).toBeDefined();
  });

  test('non-boolean isActive -> 422', async () => {
    const id = await makeDef();
    const res = await adminReq().patch(url(id)).send({ isActive: 'yes' });
    expect(res.status).toBe(422);
    expect(res.body.errors.isActive).toBeDefined();
  });

  test('attempt to patch a non-editable field (type) -> 422', async () => {
    const id = await makeDef();
    const res = await adminReq().patch(url(id)).send({ type: 'HACKED_TYPE' });
    expect(res.status).toBe(422);
    expect(res.body.errors.type).toBeDefined();
    // type is unchanged (still the throwaway type, not 'HACKED_TYPE').
    const rows = await prisma.$queryRawUnsafe(
      `SELECT type FROM bounty_definitions WHERE id = $1::uuid`, id);
    expect(rows[0].type).not.toBe('HACKED_TYPE');
  });
});
