'use strict';

// RewardIssuanceService — issues one (user, leaderboard, period, tier) reward.
//
// Contract:
//   1. Acquire pg_advisory_xact_lock(hashtext(user_id|lb_key|period_key)) — disjoint
//      from the worker's per-period lock space. Lets parallel reward issuance
//      across users in one finalization run without conflict.
//   2. INSERT leaderboard_reward_events with literal idempotency key
//        'lb_reward:{lb_key}:{period_key}:{user_id}:{tier}'
//      via ON CONFLICT (idempotency_key) DO NOTHING. If no row inserted →
//      already issued, return { issued: false }.
//   3. Resolve each bundle entry's slug → cosmetic id, INSERT user_rewards
//      ON CONFLICT DO NOTHING. The reward_bundle_snapshot already frozen on the
//      event row preserves audit-trail integrity even if the cosmetic catalogue
//      slug is later renamed.
//   4. Write one inbox_entries row of type 'leaderboard_reward' summarizing it.
//
// All four steps run in a single transaction so a crash mid-issuance never
// leaves a reward_event without its user_rewards or inbox_entry.
//
// "Frozen" guarantee: reward_bundle_snapshot is a deep copy of the bundle at
// issue time. If leaderboard_rewards.reward_bundle is edited later, the snapshot
// here is unchanged — tested explicitly.

const prisma = require('../../lib/prisma');
const InboxService = require('./InboxService');

const TIER_LABELS = {
  top_1: 'Top 1',
  top_3: 'Top 3',
  top_10: 'Top 10',
};

const REWARD_TYPE_TO_TABLE = {
  calling_card: 'calling_cards',
  badge:        'badges',
  flourish:     'flourishes',
  title:        'titles',
};

/**
 * Build the literal idempotency key. Asserted by string equality in tests.
 */
function buildIdempotencyKey({ leaderboardKey, periodKey, userId, placementTier }) {
  return `lb_reward:${leaderboardKey}:${periodKey}:${userId}:${placementTier}`;
}

/**
 * Resolve a single bundle entry's slug to a catalogue id. Returns null when
 * the slug is unknown (or the cosmetic is inactive) — caller should log and
 * skip rather than fail the whole issuance, since the reward_bundle_snapshot
 * on the event row still preserves the intent.
 */
async function resolveBundleEntry(tx, { reward_type, reward_slug }) {
  const table = REWARD_TYPE_TO_TABLE[reward_type];
  if (!table) return null;
  // Table names come from a closed allow-list, never user input → safe to inline.
  const rows = await tx.$queryRawUnsafe(
    `SELECT id FROM ${table} WHERE slug = $1 AND is_active = TRUE LIMIT 1`,
    reward_slug
  );
  if (!rows[0]) return null;
  return rows[0].id;
}

/**
 * Issue one reward. Caller passes the full bundle (typically materialized by
 * PeriodFinalizationService from the leaderboard_rewards row). Returns:
 *   { issued: true, eventId, userRewardCount, inboxEntryId }   on first issue
 *   { issued: false, reason: 'already_issued' }                on repeat
 */
async function issue(prismaClient, {
  userId, leaderboardKey, periodKey, placementTier, rewardBundle,
}) {
  if (!userId)          throw new Error('issue: userId is required');
  if (!leaderboardKey)  throw new Error('issue: leaderboardKey is required');
  if (!periodKey)       throw new Error('issue: periodKey is required');
  if (!placementTier)   throw new Error('issue: placementTier is required');
  if (!Array.isArray(rewardBundle)) {
    throw new Error('issue: rewardBundle must be an array');
  }

  const userIdBig = BigInt(userId);
  const idempotencyKey = buildIdempotencyKey({
    leaderboardKey, periodKey, userId: userIdBig, placementTier,
  });

  return prismaClient.$transaction(async (tx) => {
    // Per-user × per-board × per-period lock. Disjoint from the worker's
    // per-period lock (which is hashtext(lb_key|period_key)) — different inputs.
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(
         hashtext($1::text || '|' || $2 || '|' || $3)::bigint
       )`,
      userIdBig.toString(), leaderboardKey, periodKey
    );

    // Freeze the bundle as JSON on the event row. ON CONFLICT on idempotency_key
    // makes the insert a true once-only operation across retries.
    const snapshotJson = JSON.stringify(rewardBundle);
    const eventRows = await tx.$queryRawUnsafe(
      `INSERT INTO leaderboard_reward_events
         (user_id, leaderboard_key, period_key, placement_tier,
          reward_bundle_snapshot, idempotency_key)
       VALUES ($1, $2, $3, $4::"PlacementTier", $5::jsonb, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      userIdBig, leaderboardKey, periodKey, placementTier,
      snapshotJson, idempotencyKey
    );
    if (eventRows.length === 0) {
      return { issued: false, reason: 'already_issued' };
    }
    const eventId = eventRows[0].id;

    // Resolve slugs → ids, insert user_rewards. Skip entries with unresolvable
    // slugs (logged via the snapshot on the event row).
    let userRewardCount = 0;
    for (const entry of rewardBundle) {
      // eslint-disable-next-line no-await-in-loop
      const rewardId = await resolveBundleEntry(tx, entry);
      if (rewardId == null) continue;
      const tier = entry.tier != null ? Number(entry.tier) : null;
      // eslint-disable-next-line no-await-in-loop
      const ins = await tx.$queryRawUnsafe(
        `INSERT INTO user_rewards
           (user_id, reward_type, reward_id, tier, source_type, source_id)
         VALUES ($1, $2::"RewardType", $3, $4, 'leaderboard'::"RewardSource", $5)
         ON CONFLICT (user_id, reward_type, reward_id, (COALESCE(tier, 0)))
           DO NOTHING
         RETURNING id`,
        userIdBig, entry.reward_type, BigInt(rewardId), tier, periodKey
      );
      if (ins.length > 0) userRewardCount += 1;
    }

    // Write the inbox entry. Idempotency at the inbox level is implicit:
    // we only reach this branch when the reward_event row was freshly inserted.
    const title = `You placed ${TIER_LABELS[placementTier] || placementTier} on ${leaderboardKey}`;
    const body  = `Congrats — your placement on ${leaderboardKey} for ${periodKey} earned ${rewardBundle.length} reward(s).`;
    const inbox = await InboxService.create(tx, {
      userId: userIdBig,
      entryType: 'leaderboard_reward',
      title,
      body,
      referenceType: 'leaderboard_period',
      referenceId: `${leaderboardKey}:${periodKey}`,
      metadata: {
        leaderboard_key: leaderboardKey,
        period_key: periodKey,
        placement_tier: placementTier,
        reward_bundle: rewardBundle,
      },
    });

    return {
      issued: true,
      eventId,
      userRewardCount,
      inboxEntryId: inbox.id,
    };
  });
}

module.exports = {
  issue,
  buildIdempotencyKey,
  // exposed for testing
  resolveBundleEntry,
};
