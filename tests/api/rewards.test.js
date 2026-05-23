'use strict';

const request = require('supertest');
const app = require('../../src/app');
const prisma = require('../../src/lib/prisma');
const { createFreshUser } = require('../helpers/dex');

const createdUserIds = [];

async function getCosmeticId(table, slug) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM ${table} WHERE slug = $1`, slug
  );
  return rows[0]?.id != null ? String(rows[0].id) : null;
}

async function grantReward(userId, rewardType, rewardIdStr, tier = null) {
  await prisma.$queryRawUnsafe(
    `INSERT INTO user_rewards
       (user_id, reward_type, reward_id, tier, source_type, source_id)
     VALUES ($1, $2::"RewardType", $3, $4, 'admin_grant'::"RewardSource", 'test')
     ON CONFLICT (user_id, reward_type, reward_id, (COALESCE(tier, 0))) DO NOTHING`,
    BigInt(userId), rewardType, BigInt(rewardIdStr), tier
  );
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await prisma.$queryRawUnsafe(
      `UPDATE "User" SET primary_calling_card_id = NULL,
                          equipped_badge_slot_1 = NULL,
                          equipped_badge_slot_2 = NULL,
                          equipped_badge_slot_3 = NULL
        WHERE id = $1`, BigInt(id)
    );
    await prisma.$queryRawUnsafe(`DELETE FROM user_rewards WHERE user_id = $1`, BigInt(id));
    // User rows kept (see leaderboards.test.js note).
  }
  await prisma.$disconnect();
});

describe('GET /api/rewards/me', () => {
  test('401 without auth', async () => {
    const res = await request(app).get('/api/rewards/me');
    expect(res.status).toBe(401);
  });

  test('returns owned cosmetics by type and equipped state', async () => {
    const u = await createFreshUser('rw-list');
    createdUserIds.push(u.userId);

    const cardId  = await getCosmeticId('calling_cards', 'cc_weekly_xp_champion');
    const badgeId = await getCosmeticId('badges',        'bd_weekly_xp_top_1');
    const titleId = await getCosmeticId('titles',        'ti_xp_champion');
    await grantReward(u.userId, 'calling_card', cardId);
    await grantReward(u.userId, 'badge',        badgeId);
    await grantReward(u.userId, 'title',        titleId);

    const res = await request(app)
      .get('/api/rewards/me')
      .set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.calling_cards.map((c) => c.slug)).toContain('cc_weekly_xp_champion');
    expect(res.body.data.badges.map((b) => b.slug)).toContain('bd_weekly_xp_top_1');
    expect(res.body.data.titles.map((t) => t.slug)).toContain('ti_xp_champion');
    expect(res.body.data.flourishes).toEqual([]);
    expect(res.body.data.equipped).toEqual({
      primary_calling_card_id: null,
      equipped_badge_slot_1: null,
      equipped_badge_slot_2: null,
      equipped_badge_slot_3: null,
    });
  });
});

describe('PATCH /api/rewards/me/equip', () => {
  test('equipping owned cosmetics updates equipped state', async () => {
    const u = await createFreshUser('rw-equip');
    createdUserIds.push(u.userId);
    const cardId  = await getCosmeticId('calling_cards', 'cc_weekly_xp_champion');
    const badgeId = await getCosmeticId('badges',        'bd_weekly_xp_top_1');
    await grantReward(u.userId, 'calling_card', cardId);
    await grantReward(u.userId, 'badge',        badgeId);

    const res = await request(app)
      .patch('/api/rewards/me/equip')
      .set('Authorization', `Bearer ${u.token}`)
      .send({
        primary_calling_card_id: cardId,
        equipped_badge_slot_1: badgeId,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.equipped.primary_calling_card_id).toBe(cardId);
    expect(res.body.data.equipped.equipped_badge_slot_1).toBe(badgeId);
  });

  test('422 when equipping unowned cosmetic', async () => {
    const u = await createFreshUser('rw-noown');
    createdUserIds.push(u.userId);
    const badgeId = await getCosmeticId('badges', 'bd_weekly_xp_top_1');

    const res = await request(app)
      .patch('/api/rewards/me/equip')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ equipped_badge_slot_1: badgeId });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe('equipped_badge_slot_1');
  });

  test('null clears an equipped slot', async () => {
    const u = await createFreshUser('rw-clear');
    createdUserIds.push(u.userId);
    const cardId = await getCosmeticId('calling_cards', 'cc_weekly_xp_champion');
    await grantReward(u.userId, 'calling_card', cardId);

    await request(app)
      .patch('/api/rewards/me/equip')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ primary_calling_card_id: cardId });

    const res = await request(app)
      .patch('/api/rewards/me/equip')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ primary_calling_card_id: null });
    expect(res.status).toBe(200);
    expect(res.body.data.equipped.primary_calling_card_id).toBeNull();
  });
});
