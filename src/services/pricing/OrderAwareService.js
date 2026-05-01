const pricing = require("../../../config/pricing");

/**
 * Unique voters in cycle (email-verified only, user_weight > 0).
 */
async function uniqueVotersInCycle(prisma, brickId, cycleId) {
  const result = await prisma.voteEvent.groupBy({
    by: ["userId"],
    where: {
      brickId,
      cycleId,
      userWeightAtVote: { gt: 0 },
    },
    _count: { userId: true },
  });
  return result.length;
}

/**
 * Catch-up enabled if: weighted_total >= 15, unique_voters >= 12, dominant_pct >= 0.60,
 * order-aware passes, and NOT clustered. Spec §18.2.
 */
async function isCatchupEnabled(
  prisma,
  brickId,
  cycleId,
  direction,
  weightedTotal,
  uniqueVoters,
  dominantPct,
) {
  const minW = pricing.catchup_min_weighted_total;
  const minU = pricing.catchup_min_unique_voters;
  const minD = pricing.catchup_min_dominant_pct;
  if (weightedTotal < minW || uniqueVoters < minU || dominantPct < minD) {
    return false;
  }
  const voteType = direction === "UP" ? "OVER" : "UNDER";
  const orderOk = await orderAwarePasses(prisma, brickId, cycleId, voteType);
  if (!orderOk) return false;
  const clustered = await clusteredVotesDetected(prisma, brickId, cycleId);
  return !clustered;
}

async function orderAwarePasses(prisma, brickId, cycleId, voteType) {
  const w10Threshold = pricing.catchup_w10_threshold;
  const w20Threshold = pricing.catchup_w20_threshold;

  const w10 = await prisma.voteEvent.findMany({
    where: {
      brickId,
      cycleId,
      userWeightAtVote: { gt: 0 },
    },
    orderBy: { id: "desc" },
    take: 10,
  });
  const w20 = await prisma.voteEvent.findMany({
    where: {
      brickId,
      cycleId,
      userWeightAtVote: { gt: 0 },
    },
    orderBy: { id: "desc" },
    take: 20,
  });

  if (w10.length < 10 || w20.length < 20) return false;
  const w10Share = w10.filter((e) => e.voteType === voteType).length / 10;
  const w20Share = w20.filter((e) => e.voteType === voteType).length / 20;
  return w10Share >= w10Threshold && w20Share >= w20Threshold;
}

async function clusteredVotesDetected(prisma, brickId, cycleId) {
  const clusterTime = pricing.catchup_cluster_time_seconds * 1000;
  const maxIps = pricing.catchup_cluster_max_ips;

  const w10 = await prisma.voteEvent.findMany({
    where: {
      brickId,
      cycleId,
      userWeightAtVote: { gt: 0 },
    },
    orderBy: { id: "desc" },
    take: 10,
  });
  if (w10.length < 10) return false;

  const first = w10[w10.length - 1];
  const last = w10[0];
  const span = new Date(last.createdAt) - new Date(first.createdAt);
  if (span > clusterTime) return false;

  const uniqueIps = new Set(w10.map((e) => e.ipHash).filter(Boolean)).size;
  return uniqueIps <= maxIps;
}

module.exports = {
  uniqueVotersInCycle,
  isCatchupEnabled,
};
