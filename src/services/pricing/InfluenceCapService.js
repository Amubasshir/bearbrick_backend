const pricing = require("../../../config/pricing");

/**
 * Check and cap user weight to maintain per-cycle influence cap (15% max).
 * Returns capped weight if needed, otherwise returns original weight.
 */
async function checkAndCapUserWeight(
  prisma,
  userId,
  brickId,
  cycleId,
  userWeight,
  currentWeightedTotal,
  currentVoteEventId = null
) {
  // Calculate user's current contribution in this cycle
  // Only count votes processed BEFORE the current vote (id < currentVoteEventId)
  // This ensures we use the same baseline as actualWeightedTotal calculation
  const whereClause = {
    userId: userId,
    brickId: brickId,
    cycleId: cycleId,
    userWeightAtVote: { gt: 0 },
  };
  if (currentVoteEventId != null) {
    whereClause.id = { lt: currentVoteEventId };
  }

  const userVotes = await prisma.voteEvent.findMany({
    where: whereClause,
    select: {
      userWeightAtVote: true,
    },
  });

  const userCurrentContribution = userVotes.reduce(
    (sum, vote) => sum + Number(vote.userWeightAtVote),
    0
  );

  // Calculate what the total would be after adding this vote
  // IMPORTANT: Use actualWeightedTotal (from previously processed votes in this cycle)
  // not the state's weightedTotal which might be stale or from a different cycle
  const newWeightedTotal = currentWeightedTotal + userWeight;
  const newUserContribution = userCurrentContribution + userWeight;

  // Check if user would exceed 15% cap
  if (newWeightedTotal > 0) {
    const userShare = newUserContribution / newWeightedTotal;
    const capPct = pricing.per_cycle_influence_cap_pct;

    if (userShare > capPct) {
      // Cap the weight to maintain 15% max
      const maxAllowedContribution = newWeightedTotal * capPct;
      const cappedWeight = Math.max(
        0,
        maxAllowedContribution - userCurrentContribution
      );
      // Ensure we don't return negative or zero if user already exceeded cap
      // If userCurrentContribution already exceeds maxAllowedContribution, return 0
      return Math.min(userWeight, cappedWeight);
    }
  }

  return userWeight;
}

module.exports = { checkAndCapUserWeight };
