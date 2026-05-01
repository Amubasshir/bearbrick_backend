const pricing = require("../../../config/pricing");

/**
 * Find scoring-eligible votes for a cycle close.
 * Returns last non-FAIR vote per user, excluding votes during freeze windows.
 */
async function findScoringEligibleVotes(prisma, brickId, cycleId, closedAt) {
  // Get all candidate votes (non-FAIR, verified users only, before cycle close)
  const candidates = await prisma.voteEvent.findMany({
    where: {
      brickId: brickId,
      cycleId: cycleId,
      voteType: { in: ["UNDER", "OVER"] },
      userWeightAtVote: { gt: 0 },
      createdAt: { lte: closedAt },
    },
    orderBy: [{ userId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
  });

  // Get freeze windows for this brick+cycle
  const freezeWindows = await prisma.brickFreezeWindowEvent.findMany({
    where: {
      brickId: brickId,
      cycleId: cycleId,
      freezeEnteredAt: { lte: closedAt },
    },
  });

  // Filter out votes during freeze windows
  const filtered = candidates.filter((vote) => {
    const voteTime = new Date(vote.createdAt);
    return !freezeWindows.some((window) => {
      const enteredAt = new Date(window.freezeEnteredAt);
      const exitedAt = window.freezeExitedAt
        ? new Date(window.freezeExitedAt)
        : closedAt;
      return voteTime >= enteredAt && voteTime <= exitedAt;
    });
  });

  // Reduce to one vote per user (last vote)
  const lastVotePerUser = new Map();
  for (const vote of filtered) {
    if (!lastVotePerUser.has(vote.userId)) {
      lastVotePerUser.set(vote.userId, vote);
    }
  }

  return Array.from(lastVotePerUser.values());
}

/**
 * Check if a vote aligns with cycle outcome.
 * OVER aligns with UP, UNDER aligns with DOWN.
 */
function isAligned(voteType, outcome) {
  if (outcome === "FLAT") return false; // FLAT cycles are ignored
  if (voteType === "OVER" && outcome === "UP") return true;
  if (voteType === "UNDER" && outcome === "DOWN") return true;
  return false;
}

/**
 * Calculate trust score from accuracy ratio.
 * trust_score = clamp((accuracy - 0.5) * 2, -1.0, +1.0)
 */
function calculateTrustScore(alignedVotes, misalignedVotes) {
  const total = alignedVotes + misalignedVotes;
  if (total < pricing.trust_min_scored_votes) {
    return 0.0; // Neutral prior until enough evidence
  }
  const accuracy = alignedVotes / total;
  const trustScore = (accuracy - 0.5) * 2;
  return Math.max(-1.0, Math.min(1.0, trustScore));
}

/**
 * Assign trust tier from trust score.
 */
function assignTrustTier(trustScore) {
  if (trustScore < -0.25) return "UNTRUSTED";
  if (trustScore < -0.05) return "PROBATION";
  if (trustScore < 0.2) return "NEUTRAL";
  if (trustScore <= 0.6) return "RELIABLE";
  return "PROVEN";
}

/**
 * Check if user needs cooldown (3 misaligned in last 5 scored votes).
 */
async function checkCooldown(prisma, userId) {
  const lastScored = await prisma.trustScoreEvent.findMany({
    where: { userId: userId },
    orderBy: { createdAt: "desc" },
    take: pricing.trust_cooldown_window_size,
  });

  const misalignedCount = lastScored.filter((e) => !e.aligned).length;
  if (misalignedCount >= pricing.trust_cooldown_misaligned_threshold) {
    const cooldownUntil = new Date();
    cooldownUntil.setHours(
      cooldownUntil.getHours() + pricing.trust_cooldown_duration_hours
    );
    return cooldownUntil;
  }
  return null;
}

module.exports = {
  findScoringEligibleVotes,
  isAligned,
  calculateTrustScore,
  assignTrustTier,
  checkCooldown,
};
