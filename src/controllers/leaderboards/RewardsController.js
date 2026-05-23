'use strict';

// GET  /api/rewards/me           — owned cosmetics + equipped state
// PATCH /api/rewards/me/equip    — equip owned cosmetics; ownership enforced
//
// Ownership: a user can only equip a cosmetic whose row exists in user_rewards
// for that user. Mismatch → 422 (unprocessable, semantically valid but rejected).
//
// `tier` on user_rewards is null-safe-unique via COALESCE — the GET shapes
// each row with its tier so the UI can show distinct unlock levels.

const prisma = require('../../lib/prisma');

const REWARD_TYPES = ['calling_card', 'badge', 'flourish', 'title'];
const TYPE_TO_TABLE = {
  calling_card: 'calling_cards',
  badge: 'badges',
  flourish: 'flourishes',
  title: 'titles',
};
const TYPE_TO_OUT_KEY = {
  calling_card: 'calling_cards',
  badge: 'badges',
  flourish: 'flourishes',
  title: 'titles',
};

/**
 * Fetch all rewards owned by the user. Joins each user_rewards row against the
 * relevant cosmetic table to surface slug + name + asset_ref.
 * Returns { calling_cards, badges, flourishes, titles } each as an array.
 */
async function listOwnedByType(userId) {
  const out = { calling_cards: [], badges: [], flourishes: [], titles: [] };
  for (const type of REWARD_TYPES) {
    const table = TYPE_TO_TABLE[type];
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ur.id AS user_reward_id, ur.tier, ur.unlocked_at,
              ur.source_type, ur.source_id,
              c.id AS reward_id, c.slug, c.name${type === 'calling_card' ? ', c.rarity, c.is_hidden_until_unlocked, c.tiered' : ''}${type !== 'title' ? ', c.asset_ref' : ''}
         FROM user_rewards ur
         JOIN ${table} c ON c.id = ur.reward_id
        WHERE ur.user_id = $1
          AND ur.reward_type = $2::"RewardType"
        ORDER BY ur.unlocked_at DESC, ur.id DESC`,
      BigInt(userId), type
    );
    out[TYPE_TO_OUT_KEY[type]] = rows.map((r) => ({
      id: String(r.reward_id),
      user_reward_id: String(r.user_reward_id),
      slug: r.slug,
      name: r.name,
      tier: r.tier,
      rarity: r.rarity || null,
      asset_ref: r.asset_ref || null,
      source_type: r.source_type,
      source_id: r.source_id || null,
      unlocked_at: r.unlocked_at instanceof Date ? r.unlocked_at.toISOString() : r.unlocked_at,
    }));
  }
  return out;
}

async function listMe(req, res) {
  try {
    const userId = BigInt(req.user.id);
    const owned = await listOwnedByType(userId);

    const userRows = await prisma.$queryRawUnsafe(
      `SELECT primary_calling_card_id, equipped_badge_slot_1,
              equipped_badge_slot_2, equipped_badge_slot_3
         FROM "User" WHERE id = $1`,
      userId
    );
    const u = userRows[0] || {};
    return res.status(200).json({
      success: true,
      data: {
        calling_cards: owned.calling_cards,
        badges: owned.badges,
        flourishes: owned.flourishes,
        titles: owned.titles,
        equipped: {
          primary_calling_card_id: u.primary_calling_card_id != null
            ? String(u.primary_calling_card_id) : null,
          equipped_badge_slot_1: u.equipped_badge_slot_1 != null
            ? String(u.equipped_badge_slot_1) : null,
          equipped_badge_slot_2: u.equipped_badge_slot_2 != null
            ? String(u.equipped_badge_slot_2) : null,
          equipped_badge_slot_3: u.equipped_badge_slot_3 != null
            ? String(u.equipped_badge_slot_3) : null,
        },
      },
    });
  } catch (err) {
    console.error('[RewardsController.listMe] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

/**
 * Verifies ownership for one (rewardType, rewardId). Returns true if user
 * owns the cosmetic, false otherwise.
 */
async function ownsReward(userId, rewardType, rewardId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM user_rewards
      WHERE user_id = $1 AND reward_type = $2::"RewardType" AND reward_id = $3
      LIMIT 1`,
    BigInt(userId), rewardType, BigInt(rewardId)
  );
  return rows.length > 0;
}

async function equip(req, res) {
  try {
    const userId = BigInt(req.user.id);
    const body = req.body || {};

    const updates = {};
    const fields = [
      ['primary_calling_card_id', 'calling_card'],
      ['equipped_badge_slot_1', 'badge'],
      ['equipped_badge_slot_2', 'badge'],
      ['equipped_badge_slot_3', 'badge'],
    ];

    for (const [field, type] of fields) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value === null) {
        updates[field] = null;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const ok = await ownsReward(userId, type, value);
      if (!ok) {
        return res.status(422).json({
          success: false,
          message: `Cannot equip ${field}: not owned`,
          field,
        });
      }
      updates[field] = BigInt(value);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No equip fields supplied',
      });
    }

    const setClauses = [];
    const params = [];
    for (const [field, value] of Object.entries(updates)) {
      params.push(value);
      // Field names come from a closed allow-list (`fields` above), never user input → safe.
      setClauses.push(`${field} = $${params.length}`);
    }
    params.push(userId);
    await prisma.$executeRawUnsafe(
      `UPDATE "User" SET ${setClauses.join(', ')}, "updatedAt" = NOW()
        WHERE id = $${params.length}`,
      ...params
    );

    return listMe(req, res);
  } catch (err) {
    console.error('[RewardsController.equip] error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

module.exports = { listMe, equip };
